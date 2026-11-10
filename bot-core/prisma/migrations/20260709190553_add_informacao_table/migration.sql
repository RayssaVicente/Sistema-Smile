-- CreateTable
CREATE TABLE "public"."Informacao" (
    "id" SERIAL NOT NULL,
    "valor" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Informacao_pkey" PRIMARY KEY ("id")
);
