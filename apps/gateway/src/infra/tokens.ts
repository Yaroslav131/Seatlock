// Токены для внедрения зависимостей. Symbol вместо строки — чтобы
// случайно не столкнуться именами с другим модулем.
export const POSTGRES_POOL = Symbol('POSTGRES_POOL');
export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
