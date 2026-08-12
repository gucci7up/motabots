import { Injectable } from '@nestjs/common';
import { Category } from '@prisma/client';
import { DomainErrorCode, DomainException } from '../common/exceptions/domain.exception';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(includeInactive = false): Promise<Category[]> {
    return this.prisma.category.findMany({
      where: includeInactive ? undefined : { isActive: true },
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string): Promise<Category> {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) {
      throw DomainException.notFound('la categoría', id);
    }
    return category;
  }

  async findByName(name: string): Promise<Category | null> {
    return this.prisma.category.findUnique({ where: { name } });
  }

  async create(name: string, description?: string): Promise<Category> {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      throw new DomainException(
        DomainErrorCode.VALIDATION_FAILED,
        'El nombre de la categoría no puede estar vacío.',
      );
    }

    const existing = await this.prisma.category.findUnique({ where: { name: trimmed } });
    if (existing) {
      throw new DomainException(DomainErrorCode.CONFLICT, 'Ya existe una categoría con ese nombre.');
    }

    return this.prisma.category.create({
      data: { name: trimmed, description: description?.trim() || null },
    });
  }

  /**
   * Desactiva la categoría en lugar de borrarla: hay productos y ventas históricas que la
   * referencian, y borrarla dejaría el histórico sin contexto.
   */
  async deactivate(id: string): Promise<Category> {
    await this.findById(id);
    return this.prisma.category.update({ where: { id }, data: { isActive: false } });
  }
}
