# Kubernetes (kind) — учебный трек

Локальный кластер для практики с Kubernetes: балансировка через Service, отказоустойчивость,
автомасштабирование по CPU (HPA). Прод на это не переезжает (остаётся `docker-compose.prod.yml` +
Caddy, см. [ADR 0007](../../docs/adr/0007-gateway-allowlist-limits-cache-replicas.md)); почему
именно так и что здесь упрощено — [ADR 0008](../../docs/adr/0008-kind-local-kubernetes.md).

## Предпосылки

- Поднят dev-стек инфраструктуры: `pnpm infra:up` (Postgres/Redis/RabbitMQ/MinIO/Mailpit) —
  кластер использует его, а не поднимает свой Postgres.
- Установлен [kind](https://kind.sigs.k8s.io/) и `kubectl` (в Docker Desktop он уже есть).
- Docker Desktop с Kubernetes-движком (обычный Docker Desktop на Windows/Mac подходит).

## Запуск

```bash
./deploy/k8s/up.sh
```

Поднимает кластер (если его ещё нет), ставит ingress-nginx, собирает образы шести сервисов
(`gateway`, `auth`, `catalog`, `booking`, `payment`, `notification` — без `apps/web`, трек про
бэкенд), грузит их в кластер и разворачивает манифесты. Повторный запуск пересобирает образы
и перезапускает поды, чтобы подхватить новый код (тег образа не меняется, поэтому нужен
`rollout restart`).

Проверка:

```bash
curl --resolve seatlock.local:18080:127.0.0.1 http://seatlock.local:18080/health
curl --resolve seatlock.local:18080:127.0.0.1 http://seatlock.local:18080/api/catalog/events
```

`seatlock.local` — условное имя хоста для Ingress; `--resolve` подставляет его на мэппинг
18080→80 из `kind-config.yaml`, без правки `hosts`. Порты 18080/18443, а не 80/443 — чтобы не
конфликтовать с Windows (порт 80 часто занят) и с dev-стеком (3000–3006).

## Структура

| Файл                  | Что                                                           |
| --------------------- | ------------------------------------------------------------- |
| `kind-config.yaml`    | один узел, проброс портов 18080/18443 для Ingress             |
| `00-namespace.yaml`   | namespace `seatlock`                                          |
| `01-configmap.yaml`   | несекретные переменные (адреса сервисов, порты, S3/SMTP)      |
| `02-secret.yaml`      | те же dev-заглушки, что в `.env.example`, не боевые секреты   |
| `03`–`08-*.yaml`      | Deployment (2 реплики) + Service на каждый из 6 сервисов      |
| `09-ingress.yaml`     | единственный вход, на `gateway` (тот же принцип, что у Caddy) |
| `10-hpa-gateway.yaml` | автомасштабирование `gateway` по CPU (2–6 реплик)             |
| `up.sh` / `down.sh`   | поднять / удалить кластер целиком                             |

## Проверка балансировки

Service распределяет запросы между репликами сам (iptables/IPVS), без Caddy/`least_conn`
из прода. Увидеть это:

```bash
GW1=$(kubectl -n seatlock get pods -l app=gateway -o jsonpath='{.items[0].metadata.name}')
GW2=$(kubectl -n seatlock get pods -l app=gateway -o jsonpath='{.items[1].metadata.name}')
count() { kubectl -n seatlock exec "$1" -- node -e "fetch('http://127.0.0.1:3000/metrics').then(r=>r.text()).then(t=>{const m=t.split('\n').filter(l=>l.startsWith('http_requests_total')&&l.includes('route=\"/health\"'));console.log(m.map(l=>Number(l.split(' ').pop())).reduce((a,b)=>a+b,0))})"; }

b1=$(count "$GW1"); b2=$(count "$GW2")
for i in $(seq 1 60); do curl -s -o /dev/null --resolve seatlock.local:18080:127.0.0.1 http://seatlock.local:18080/health; done
a1=$(count "$GW1"); a2=$(count "$GW2")
echo "$GW1: $((a1-b1))"
echo "$GW2: $((a2-b2))"
```

При первом прогоне разделилось 29/33 из 60 — менее ровно, чем `least_conn` у Caddy (здесь ближе
к случайному выбору эндпоинта), но без единой точки отказа.

Отказоустойчивость — удалить один под под нагрузкой и убедиться, что ошибок не было:

```bash
kubectl -n seatlock delete pod "$GW1" --wait=false
for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code}\n' --resolve seatlock.local:18080:127.0.0.1 http://seatlock.local:18080/health; done | sort | uniq -c
```

Замена пода создаётся автоматически; пока новый не станет `Ready` (readinessProbe `/health/ready`),
Service не пошлёт на него трафик.

## Автомасштабирование (HPA)

`gateway` масштабируется от 2 до 6 реплик по загрузке CPU (порог — 50% от `requests.cpu: 50m`,
то есть в среднем 25m на под; порог занижен специально, чтобы масштабирование было видно за
секунды, а не требовало полноценного нагрузочного теста). Нужен `metrics-server` — `up.sh`
ставит его сам при первом создании кластера.

Проверка — создать внутри кластера под, который бьёт по `gateway` в 60 параллельных потоков,
и смотреть на число реплик:

```bash
kubectl -n seatlock run load-gen --image=busybox:1.36 --restart=Never -- \
  sh -c 'for i in $(seq 1 60); do (while true; do wget -q -O- http://gateway:3000/health >/dev/null; done) & done; sleep 240'
watch kubectl -n seatlock get hpa gateway
# когда наблюдения достаточно:
kubectl -n seatlock delete pod load-gen
```

На прогоне 22 сентября 2026: 2 реплики → 4 (через ~15 с, первый цикл сверки HPA) → 6 (ещё
через ~15 с, упёрлись в `maxReplicas`) — загрузка при этом продолжала расти дальше 50%
порога (до ~500%), то есть 60 потоков busybox генерировали больше нагрузки, чем даже 6 реплик
могли переварить в рамках `limits.cpu: 300m` на под. После остановки генератора нагрузка упала
почти сразу, а число реплик снижалось постепенно — 6 → 5 → 3 → 2 за минуту: `scaleDown.
stabilizationWindowSeconds: 60` намеренно не даёт откатиться мгновенно на случайном затишье.

## Ограничения этого прохода

- Инфраструктура вне кластера (см. ADR 0008) — не PersistentVolume/StatefulSet.
- Миграции Prisma не запускаются кластером: поды используют уже мигрированную dev-базу.
- Фронтенд не разворачивается.
- HPA только на `gateway`, только по CPU; порог занижен для наглядности демонстрации, не подобран
  по реальному трафику. Настоящий нагрузочный тест (`packages/load-test`) против кластера — ещё
  не делали.

## Остановка

```bash
./deploy/k8s/down.sh
```

Удаляет кластер целиком. Инфраструктуру (`docker-compose.yml`) не трогает — гасить отдельно
`pnpm infra:down`, если нужно.
