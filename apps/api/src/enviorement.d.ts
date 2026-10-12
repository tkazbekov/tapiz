import { type Server } from 'socket.io';

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      API_URL: string;
      API_HOST: string;
      API_PORT: string;
      FRONTEND_URL: string;
      AI_AGENT_LOGIN_ENABLED?: string;
      SESSION_COOKIE_SECURE?: string;
      TRUST_PROXY?: string;
      UPLOADS_DIR?: string;
      AUTH_LOG_RESET_LINKS?: string;
    }
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
  }
}

export {};
