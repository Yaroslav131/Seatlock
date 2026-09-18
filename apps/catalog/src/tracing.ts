import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

// Отдельный файл, а не код в main.ts: инструментации (http, fetch,
// amqplib) патчат модули Node ДО того, как их кто-либо успеет
// импортировать. Проект компилируется в CommonJS, поэтому достаточно,
// чтобы это был самый первый import в main.ts (см. там) — require()
// выполняется строго в порядке написанных import.
const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'catalog' }),
  // OTEL_EXPORTER_OTLP_ENDPOINT читается самим экспортёром из
  // переменной окружения — конфигурировать адрес Jaeger в коде не нужно.
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
