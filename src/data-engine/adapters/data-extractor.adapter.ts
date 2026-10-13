import { Injectable, Logger } from '@nestjs/common';

export interface DecryptedConnectionInfo {
  id: string;
  tipoMotor: string;
  dbName: string;
  connectionString: string;
}

export interface DataExtractorAdapter {
  extract(
    connection: DecryptedConnectionInfo,
    entityName: string,
  ): Promise<Record<string, any>[]>;
}

@Injectable()
export class DataExtractorService implements DataExtractorAdapter {
  private readonly logger = new Logger(DataExtractorService.name);

  async extract(
    connection: DecryptedConnectionInfo,
    entityName: string,
  ): Promise<Record<string, any>[]> {
    this.logger.log(
      `Extrayendo datos de '${entityName}' en motor '${connection.tipoMotor}' (DB: ${connection.dbName})`,
    );

    const isNoSql = ['FIRESTORE', 'FIREBASE', 'MONGODB'].includes(
      connection.tipoMotor.toUpperCase(),
    );

    if (isNoSql) {
      return this.generateSampleNoSqlData(entityName);
    }

    return this.generateSampleSqlData(entityName);
  }

  private generateSampleSqlData(tableName: string): Record<string, any>[] {
    const records: Record<string, any>[] = [];
    for (let i = 1; i <= 20; i++) {
      records.push({
        id: `cli_${i}`,
        cliente_id: `cli_${i}`,
        nombre: `Empresa Corp ${i}`,
        email: `contacto${i}@empresacorp${i}.com`,
        telefono: `+54 9 11 4455-66${i.toString().padStart(2, '0')}`,
        pais: i % 2 === 0 ? 'Argentina' : 'México',
        activo: true,
        saldo: (i * 1500.5).toFixed(2),
      });
    }
    return records;
  }

  private generateSampleNoSqlData(collectionName: string): Record<string, any>[] {
    const documents: Record<string, any>[] = [];
    for (let i = 1; i <= 30; i++) {
      const clientIndex = (i % 20) + 1;
      documents.push({
        pedido_id: `ord_${1000 + i}`,
        cliente_id: `cli_${clientIndex}`,
        id: `ord_${1000 + i}`,
        total: (i * 240.75).toFixed(2),
        estado: i % 3 === 0 ? 'ENTREGADO' : i % 2 === 0 ? 'EN_CAMINO' : 'PENDIENTE',
        fecha_creacion: new Date(Date.now() - i * 3600 * 24 * 1000).toISOString(),
        items_count: (i % 5) + 1,
        telefono_contacto: `+1 555 019${i.toString().padStart(2, '0')}`,
      });
    }
    return documents;
  }
}
