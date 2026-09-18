import { Counter } from 'prom-client';

// Главная метрика для нагрузочного теста на ключевой инвариант проекта
// ("не продать/не занять одно место дважды") — result="conflict" здесь и
// есть счётчик того, что система реально отбивает гонки за место.
export const holdAttemptsTotal = new Counter({
  name: 'hold_attempts_total',
  help: 'Попытки занять место в booking',
  labelNames: ['result'],
});
