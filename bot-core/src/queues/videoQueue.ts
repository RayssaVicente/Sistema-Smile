import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Busca uma categoria específica com seus vídeos e já monta o objeto para o bot
export async function getVideosByCategoryKey(categoryKey: string) {
  const category = await prisma.videoCategory.findUnique({
    where: { categoryKey },
    include: { videos: true }
  });

  if (!category || category.videos.length === 0) {
    return null;
  }

  return category;
}