#!/bin/bash
# Поднимает локальный кластер kind, собирает образы шести stateless-сервисов,
# грузит их в кластер и разворачивает манифесты. Идемпотентно: повторный запуск
# пересобирает и перезагружает образы и переприменяет манифесты, кластер не трогает,
# если уже поднят. См. deploy/k8s/README.md.
set -euo pipefail
cd "$(dirname "$0")/../.."

KIND=${KIND_BIN:-kind}
SERVICES="gateway auth catalog booking payment notification"

if ! "$KIND" get clusters 2>/dev/null | grep -qx seatlock; then
  echo "== создаю кластер kind =="
  "$KIND" create cluster --config deploy/k8s/kind-config.yaml
  echo "== ставлю ingress-nginx =="
  kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.13.0/deploy/static/provider/kind/deploy.yaml
  kubectl wait --namespace ingress-nginx --for=condition=ready pod \
    --selector=app.kubernetes.io/component=controller --timeout=180s

  # metrics-server: без него HPA не видит загрузку CPU подов вообще (TARGETS: <unknown>).
  # kind использует самоподписанные сертификаты kubelet, поэтому нужен --kubelet-insecure-tls
  # (нормально для локального learning-кластера, в проде так не делают).
  echo "== ставлю metrics-server (нужен HPA) =="
  kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
  kubectl patch deployment metrics-server -n kube-system --type=json \
    -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]'
  kubectl -n kube-system rollout status deployment/metrics-server --timeout=90s
else
  echo "== кластер kind уже поднят, пропускаю создание =="
fi

echo "== собираю образы =="
for s in $SERVICES; do
  docker build -q -t "seatlock/$s:dev" -f "apps/$s/Dockerfile" .
done

echo "== гружу образы в кластер =="
for s in $SERVICES; do
  "$KIND" load docker-image "seatlock/$s:dev" --name seatlock
done

echo "== применяю манифесты =="
kubectl apply -f deploy/k8s/00-namespace.yaml -f deploy/k8s/01-configmap.yaml -f deploy/k8s/02-secret.yaml
kubectl apply -f deploy/k8s/03-gateway.yaml -f deploy/k8s/04-auth.yaml -f deploy/k8s/05-catalog.yaml \
  -f deploy/k8s/06-booking.yaml -f deploy/k8s/07-payment.yaml -f deploy/k8s/08-notification.yaml \
  -f deploy/k8s/09-ingress.yaml -f deploy/k8s/10-hpa-gateway.yaml

echo "== жду, пока поды станут Ready =="
kubectl -n seatlock rollout restart deployment --all >/dev/null
kubectl -n seatlock wait --for=condition=Ready pod --all --timeout=180s

echo
echo "Готово. Проверка:"
echo "  curl --resolve seatlock.local:18080:127.0.0.1 http://seatlock.local:18080/health"
