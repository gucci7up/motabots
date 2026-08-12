import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { PrismaService } from '../database/prisma.service';
import { UsersService } from './users.service';

const adminRole = {
  id: 'role-admin',
  name: 'ADMIN',
  permissions: [
    { permission: { code: 'users.manage' } },
    { permission: { code: 'sales.create' } },
  ],
};

const baseUser = {
  id: 'u1',
  telegramUserId: 7045646241n,
  username: 'kmota',
  firstName: 'K',
  lastName: null,
  roleId: 'role-admin',
  isActive: true,
  role: adminRole,
};

describe('UsersService', () => {
  let service: UsersService;

  const prisma = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    role: { findUnique: jest.fn() },
  };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  describe('findByTelegramId', () => {
    it('devuelve el usuario con sus permisos efectivos', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);

      const user = await service.findByTelegramId(7045646241n);

      expect(user?.roleName).toBe('ADMIN');
      expect(user?.permissions).toEqual(['users.manage', 'sales.create']);
    });

    it('devuelve null si el usuario no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findByTelegramId(999n)).resolves.toBeNull();
    });

    it('devuelve null si el usuario está inactivo', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...baseUser, isActive: false });

      await expect(service.findByTelegramId(7045646241n)).resolves.toBeNull();
    });
  });

  describe('create', () => {
    it('rechaza un ID de Telegram que no sea numérico', async () => {
      await expect(
        service.create({ telegramUserId: 'juan', roleName: 'SELLER' }, null),
      ).rejects.toThrow(DomainException);
    });

    it('rechaza un ID de Telegram ya registrado', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);

      await expect(
        service.create({ telegramUserId: '7045646241', roleName: 'SELLER' }, null),
      ).rejects.toThrow(DomainException);
    });

    it('rechaza un rol inexistente', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findUnique.mockResolvedValue(null);

      await expect(
        service.create({ telegramUserId: '123', roleName: 'SELLER' }, null),
      ).rejects.toThrow(DomainException);
    });

    it('crea el usuario y deja registro de auditoría', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findUnique.mockResolvedValue({ id: 'role-seller', name: 'SELLER' });
      prisma.user.create.mockResolvedValue({
        ...baseUser,
        id: 'u2',
        telegramUserId: 123n,
        role: { id: 'role-seller', name: 'SELLER', permissions: [] },
      });

      const user = await service.create({ telegramUserId: '123', roleName: 'SELLER' }, 'u1');

      expect(user.roleName).toBe('SELLER');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'user.created', entity: 'User', userId: 'u1' }),
      );
    });
  });

  describe('update', () => {
    it('impide desactivar al último administrador activo', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);
      prisma.user.count.mockResolvedValue(0);

      await expect(service.update('u1', { isActive: false }, 'u1')).rejects.toThrow(
        /último administrador/,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('impide degradar al último administrador', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);
      prisma.role.findUnique.mockResolvedValue({ id: 'role-seller', name: 'SELLER' });
      prisma.user.count.mockResolvedValue(0);

      await expect(service.update('u1', { roleName: 'SELLER' }, 'u1')).rejects.toThrow(
        /último administrador/,
      );
    });

    it('permite degradar si queda otro administrador activo', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);
      prisma.role.findUnique.mockResolvedValue({ id: 'role-seller', name: 'SELLER' });
      prisma.user.count.mockResolvedValue(1);
      prisma.user.update.mockResolvedValue({
        ...baseUser,
        roleId: 'role-seller',
        role: { id: 'role-seller', name: 'SELLER', permissions: [] },
      });

      const user = await service.update('u1', { roleName: 'SELLER' }, 'u1');

      expect(user.roleName).toBe('SELLER');
    });
  });

  describe('ensureAdmins', () => {
    it('no hace nada si la lista está vacía', async () => {
      await expect(service.ensureAdmins([])).resolves.toBe(0);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it('crea sólo los administradores que no existen', async () => {
      prisma.role.findUnique.mockResolvedValue({ id: 'role-admin', name: 'ADMIN' });
      prisma.user.findUnique.mockResolvedValueOnce(baseUser).mockResolvedValueOnce(null);
      prisma.user.create.mockResolvedValue(baseUser);

      const created = await service.ensureAdmins([7045646241n, 111n]);

      expect(created).toBe(1);
      expect(prisma.user.create).toHaveBeenCalledTimes(1);
    });

    it('no falla si aún no existe el rol ADMIN', async () => {
      prisma.role.findUnique.mockResolvedValue(null);

      await expect(service.ensureAdmins([111n])).resolves.toBe(0);
    });
  });
});
