#!/bin/bash
# Удаляет локальный кластер kind целиком (все namespace, ingress-nginx, поды —
# кластер одноразовый). Инфраструктуру (docker-compose.yml) не трогает.
set -euo pipefail
KIND=${KIND_BIN:-kind}
"$KIND" delete cluster --name seatlock
