import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

// Отдельный файл, а не код в main.ts: инструментации (http, fetch,
// amqplib) патчат модули Node ДО того, как их кто-либо успеет
// импортировать — обычный import в начале main.ts этого не гарантирует
// (импорты ES-модулей поднимаются все разом, порядок строк не значит
// порядок выполнения). Поэтому main.ts этот файл НЕ импортирует —
// он подгружается снаружи через "node --require ./dist/tracing.js
// ./dist/main.js" (см. package.json/Dockerfile), что грузится раньше
// любого кода main.js. В dev-режиме грузится тем же приёмом через
// NODE_OPTIONS в npm-скрипте "dev".
const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'gateway' }),
  // OTEL_EXPORTER_OTLP_ENDPOINT читается самим экспортёром из
  // переменной окружения — конфигурировать адрес Jaeger в коде не нужно.
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
