import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { AppConfigService } from '../config/app-config.service';

export interface StoredFile {
  storageKey: string;
  checksum: string;
  sizeBytes: number;
  mimeType: string;
}

/**
 * Almacenamiento de archivos generados (facturas PDF, logo).
 *
 * Los binarios no van a PostgreSQL: la base guarda `storageKey`, tamaño y checksum.
 * La implementación actual es el sistema de archivos; el contrato (clave opaca + bytes)
 * es el mismo que ofrecen S3 y MinIO, así que cambiar de backend no toca a los llamadores.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly root: string;

  constructor(private readonly config: AppConfigService) {
    this.root = resolve(this.config.storage.localPath);
  }

  async save(key: string, content: Buffer, mimeType: string): Promise<StoredFile> {
    const path = this.resolveKey(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);

    const checksum = createHash('sha256').update(content).digest('hex');
    this.logger.log(`Archivo guardado: ${key} (${content.length} bytes)`);

    return { storageKey: key, checksum, sizeBytes: content.length, mimeType };
  }

  read(key: string): Promise<Buffer> {
    return readFile(this.resolveKey(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.resolveKey(key));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resuelve la clave dentro del directorio raíz.
   * Rechaza cualquier clave que intente salirse (`../`): una clave viene de datos y no
   * debe poder escribir fuera del almacenamiento.
   */
  private resolveKey(key: string): string {
    const path = resolve(join(this.root, normalize(key)));

    if (path !== this.root && !path.startsWith(this.root + sep)) {
      throw new Error(`Clave de almacenamiento inválida: ${key}`);
    }

    return path;
  }
}
