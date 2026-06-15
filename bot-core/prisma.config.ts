import { defineConfig } from '@prisma/config';
import * as dotenv from 'dotenv';

dotenv.config();

export default defineConfig({
  datasource: {
    // Adicionamos o 'as string' no final para garantir ao TS que o valor é válido
    url: (process.env.DATABASE_URL as string) || "",
  },
});