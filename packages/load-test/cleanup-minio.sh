#!/bin/sh
# Удаляет из MinIO ТОЛЬКО PDF-билеты из списка ключей (по одному на строку,
# формат local/seatlock-tickets/tickets/<id>.pdf). Выполняется на сервере.
#
#   sh cleanup-minio.sh check                   — проверить доступ, показать первые файлы
#   sh cleanup-minio.sh delete /tmp/keys.txt    — удалить объекты из списка
#
# Почему алиас задаётся здесь: у предустановленного в контейнере алиаса
# `local` нет учётных данных, и листинг даёт Access Denied. В образе нет
# xargs, поэтому удаление — циклом while read.
#
# Для проверки на dev: COMPOSE="docker exec -i seatlock-minio" sh cleanup-minio.sh check
set -eu

[ -d ~/seatlock ] && cd ~/seatlock
COMPOSE="${COMPOSE:-docker compose -f docker-compose.prod.yml exec -T minio}"
SET_ALIAS='mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null'

case "${1:-}" in
  check)
    $COMPOSE sh -c "$SET_ALIAS && mc ls local/seatlock-tickets/tickets/" | awk 'NR<=3'
    ;;
  delete)
    KEYS="${2:?укажите файл со списком ключей}"
    # tr убирает \r: список, созданный в Windows (Set-Content), идёт с CRLF, и
    # лишний \r в конце ключа не давал бы найти объект.
    tr -d '\r' <"$KEYS" | $COMPOSE sh -c "$SET_ALIAS && n=0; while read -r k; do mc rm --quiet \"\$k\" >/dev/null && n=\$((n+1)); done; echo \"удалено: \$n\""
    ;;
  *)
    echo "использование: sh cleanup-minio.sh check | delete <файл-со-списком-ключей>" >&2
    exit 1
    ;;
esac
