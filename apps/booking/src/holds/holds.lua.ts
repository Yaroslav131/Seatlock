/**
 * Lua-скрипты держим строковыми константами прямо в TS, а не в отдельных
 * .lua файлах — не-.ts ассеты в этом монорепо уже доставляли проблем
 * (сгенерированный Prisma-клиент у catalog/auth, см. docs/adr/0002):
 * пришлось отдельно чинить копирование в dist и в Docker-образ. Строка
 * в TS компилируется сама собой, никакого отдельного шага не нужно.
 *
 * Оба скрипта строят имя "старого" ключа места прямо внутри Lua
 * (`'hold:' .. eventId .. ':' .. oldSeatId`), а не получают его через
 * KEYS[] заранее. Это безопасно только для одиночного инстанса Redis —
 * в проекте так и есть (docker-compose.prod.yml: один redis:7-alpine,
 * без кластера). На Redis Cluster все затрагиваемые скриптом ключи
 * обязаны быть объявлены в KEYS[] заранее (hash-slot routing), и этот
 * приём сломается — не переносить на кластер без пересмотра скриптов.
 */

// KEYS[1] = hold:{eventId}:{seatId}        — лочит новое место
// KEYS[2] = user-hold:{userId}:{eventId}   — активный холд юзера в этом событии
// KEYS[3] = event-holds:{eventId}          — ZSET-индекс занятых мест
// ARGV[1] = userId
// ARGV[2] = seatId (новое место)
// ARGV[3] = ttlSeconds
// ARGV[4] = eventId (чтобы собрать ключ старого места)
// ARGV[5] = nowMs
//
// Побочный эффект, которым мы пользуемся сознательно: если юзер зовёт
// это на место, которое он и так уже держит, currentHolder === ARGV[1],
// oldSeatId === ARGV[2] — обе ранние ветки не срабатывают, а SET ... EX
// просто продлевает TTL. Получаем "продлить холд" бесплатно, через тот
// же эндпоинт, без отдельного API.
export const CREATE_HOLD_SCRIPT = `
local currentHolder = redis.call('GET', KEYS[1])
if currentHolder and currentHolder ~= ARGV[1] then
  return 1
end

local oldSeatId = redis.call('GET', KEYS[2])
if oldSeatId and oldSeatId ~= ARGV[2] then
  local oldHoldKey = 'hold:' .. ARGV[4] .. ':' .. oldSeatId
  redis.call('DEL', oldHoldKey)
  redis.call('ZREM', KEYS[3], oldSeatId)
end

redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
local expiryScoreMs = tonumber(ARGV[5]) + (tonumber(ARGV[3]) * 1000)
redis.call('ZADD', KEYS[3], expiryScoreMs, ARGV[2])

return 0
`;

export const CREATE_HOLD_OK = 0;
export const CREATE_HOLD_TAKEN = 1;

// KEYS[1] = user-hold:{userId}:{eventId}
// KEYS[2] = event-holds:{eventId}
// ARGV[1] = userId
// ARGV[2] = eventId
export const RELEASE_HOLD_SCRIPT = `
local seatId = redis.call('GET', KEYS[1])
if not seatId then
  return 1
end

local holdKey = 'hold:' .. ARGV[2] .. ':' .. seatId
local holder = redis.call('GET', holdKey)
if holder == ARGV[1] then
  redis.call('DEL', holdKey)
end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], seatId)

return 0
`;

export const RELEASE_HOLD_RELEASED = 0;
export const RELEASE_HOLD_NO_HOLD = 1;
