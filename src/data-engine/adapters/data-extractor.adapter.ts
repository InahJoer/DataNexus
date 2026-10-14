import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';

export interface EncryptedConnectionInfo {
  id: string;
  tipoMotor: string;
  dbName: string;
  encryptedConnectionString: string;
}

export interface DataExtractorOptions {
  schema?: string;
}

export interface DataExtractorAdapter {
  extract(
    connection: EncryptedConnectionInfo,
    entityName: string,
    options?: DataExtractorOptions,
  ): Promise<Record<string, any>[]>;
}

export type DataExtractorFactory = (
  tipoMotor: string,
) => DataExtractorAdapter | undefined;

export const DATA_EXTRACTOR_FACTORY = Symbol('DATA_EXTRACTOR_FACTORY');

@Injectable()
export class DataExtractorService implements DataExtractorAdapter {
  private readonly logger = new Logger(DataExtractorService.name);

  constructor(
    @Inject(DATA_EXTRACTOR_FACTORY)
    private readonly createExtractor: DataExtractorFactory = () => undefined,
  ) {}

  async extract(
    connection: EncryptedConnectionInfo,
    entityName: string,
    options?: DataExtractorOptions,
  ): Promise<Record<string, any>[]> {
    this.logger.log(
      `Extrayendo datos de '${entityName}' en motor '${connection.tipoMotor}' (DB: ${connection.dbName})`,
    );

    const extractor = this.createExtractor(connection.tipoMotor);
    if (!extractor) {
      throw new BadRequestException(
        'El motor de la conexión no tiene un extractor real disponible',
      );
    }

    try {
      return await extractor.extract(connection, entityName, options);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (this.isTimeoutError(error)) {
        throw new GatewayTimeoutException(
          'La extracción excedió el tiempo permitido',
        );
      }

      // Do not expose provider errors, which can contain connection or credential details.
      this.logger.warn(
        `Falló la extracción en motor '${connection.tipoMotor}'`,
      );
      throw new BadGatewayException(
        'No fue posible extraer datos de la fuente externa',
      );
    }
  }

  private isTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: string }).code;
    return (
      code === 'ETIMEDOUT' ||
      code === 'ETIMEOUT' ||
      code === 'ESOCKETTIMEDOUT' ||
      code === 'DEADLINE_EXCEEDED' ||
      /timeout|deadline exceeded|maximum statement execution time exceeded/i.test(
        error.message,
      )
    );
  }
}
