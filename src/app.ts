import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';

import { descreverErro, type Logger } from './log.js';
import { registrarRotas, type DependenciasRotas } from './rotas.js';

export interface DependenciasApp extends DependenciasRotas {
  log: Logger;
}

/** Monta o servidor HTTP (rotas + documentação em /docs). Não escuta porta: os testes usam inject(). */
export async function construirApp({ log, ...rotas }: DependenciasApp): Promise<FastifyInstance> {
  const loggerInstance: FastifyBaseLogger = log.child({ logger: 'http' });
  const app = Fastify({
    loggerInstance,
    // Sem log por requisição: o healthcheck do Docker (a cada 30 s) encheria o "docker compose logs".
    logController: new LogController({ disableRequestLogging: true }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Detecção de Vazamento de Gás',
        description: 'Consome as leituras do ESP32 via MQTT, grava o histórico e dispara os alertas.',
        version: '1.0.0',
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  // Erros no mesmo formato da versão Python (FastAPI): 422 com {"detail": [...]} para parâmetro inválido.
  app.setErrorHandler<FastifyError>((erro, requisicao, resposta) => {
    if (erro.validation) {
      const local = erro.validationContext === 'querystring' ? 'query' : erro.validationContext;
      const detail = erro.validation.map((problema) => ({
        loc: [local, ...campoDoProblema(problema.instancePath, problema.params)],
        msg: problema.message,
        type: problema.keyword,
      }));
      return resposta.code(422).send({ detail });
    }
    if (erro.statusCode !== undefined && erro.statusCode < 500) {
      return resposta.code(erro.statusCode).send({ detail: erro.message });
    }
    requisicao.log.error({ acao: 'erro_http', erro: descreverErro(erro) }, `Erro inesperado em ${requisicao.method} ${requisicao.url}`);
    return resposta.code(500).send({ detail: 'Erro interno' });
  });
  app.setNotFoundHandler((_requisicao, resposta) => resposta.code(404).send({ detail: 'Not Found' }));

  registrarRotas(app, rotas);
  return app;
}

function campoDoProblema(caminho: string, parametros: Record<string, unknown>): string[] {
  if (typeof parametros.missingProperty === 'string') return [parametros.missingProperty];
  return caminho.split('/').filter(Boolean);
}
