# Kubernetes (kind) — учебный трек

Локальный кластер для практики с Kubernetes: балансировка через Service, отказоустойчивость,
позже — автомасштабирование. Прод на это не переезжает (остаётся `docker-compose.prod.yml` +
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

| Файл                | Что                                                           |
| ------------------- | ------------------------------------------------------------- |
| `kind-config.yaml`  | один узел, проброс портов 18080/18443 для Ingress             |
| `00-namespace.yaml` | namespace `seatlock`                                          |
| `01-configmap.yaml` | несекретные переменные (адреса сервисов, порты, S3/SMTP)      |
| `02-secret.yaml`    | те же dev-заглушки, что в `.env.example`, не боевые секреты   |
| `03`–`08-*.yaml`    | Deployment (2 реплики) + Service на каждый из 6 сервисов      |
| `09-ingress.yaml`   | единственный вход, на `gateway` (тот же принцип, что у Caddy) |
| `up.sh` / `down.sh` | поднять / удалить кластер целиком                             |

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

## Ограничения этого прохода

- Инфраструктура вне кластера (см. ADR 0008) — не PersistentVolume/StatefulSet.
- Миграции Prisma не запускаются кластером: поды используют уже мигрированную dev-базу.
- Фронтенд не разворачивается.
- Нет HPA — реплики фиксированы (`replicas: 2`), автомасштабирование следующий шаг трека.

## Остановка

```bash
./deploy/k8s/down.sh
```

Удаляет кластер целиком. Инфраструктуру (`docker-compose.yml`) не трогает — гасить отдельно
`pnpm infra:down`, если нужно.
