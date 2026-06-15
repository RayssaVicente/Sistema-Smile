import { Redis } from 'ioredis';

// No Windows local, usamos localhost. Na VPS, usaremos o nome do serviço docker.
export const connection = new Redis({
  host: 'localhost',
  port: 6379,
  maxRetriesPerRequest: null,
});