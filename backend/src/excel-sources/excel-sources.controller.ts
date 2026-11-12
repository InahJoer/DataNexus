import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';
import { ExcelFileResponseDto, RenameExcelDto, UploadExcelFieldsDto, type UploadedExcelFile } from './dto/excel-file.dto.js';
import { EXCEL_MAX_BYTES, EXCEL_MAX_ROWS } from './excel-parser.js';
import { ExcelSourcesService } from './excel-sources.service.js';

/** El archivo se procesa en memoria (multer sin `dest`) y nunca se escribe en disco; 413 si supera 10 MB. */
const EXCEL_UPLOAD = FileInterceptor('archivo', {
  limits: { fileSize: EXCEL_MAX_BYTES, files: 1, fields: 3, parts: 4 },
  fileFilter: (_request: unknown, file: { originalname: string }, callback: (error: Error | null, accept: boolean) => void) => {
    const ok = /\.(xlsx|xlsm|csv|txt|xls)$/i.test(file.originalname);
    callback(ok ? null : new BadRequestException('Sube un archivo .xlsx o .csv'), ok);
  },
});

const UPLOAD_SCHEMA = {
  schema: {
    type: 'object',
    required: ['archivo'],
    properties: {
      archivo: { type: 'string', format: 'binary', description: 'Libro .xlsx o archivo .csv (máx. 10 MB).' },
      nombre: { type: 'string', maxLength: 120 },
    },
  },
};

@ApiTags('Archivos de Excel')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('excel')
export class ExcelSourcesController {
  constructor(private readonly excel: ExcelSourcesService) {}

  @Get()
  @RequirePermission('EXPLORE_DATA')
  @ApiOperation({ summary: 'Listar los archivos de Excel del workspace con sus hojas' })
  @ApiOkResponse({ type: ExcelFileResponseDto, isArray: true })
  list(@Req() request: AuthenticatedRequest) {
    return this.excel.list(request.user);
  }

  @Get(':id')
  @RequirePermission('EXPLORE_DATA')
  @ApiOperation({ summary: 'Detalle de un archivo de Excel y los reportes guardados que lo usan' })
  @ApiOkResponse({ type: ExcelFileResponseDto })
  @ApiResponse({ status: 404, description: 'Archivo no encontrado en el workspace.' })
  get(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.excel.get(request.user, id);
  }

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post()
  @RequirePermission('MANAGE_EXCEL')
  @UseInterceptors(EXCEL_UPLOAD)
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_SCHEMA)
  @ApiOperation({
    summary: 'Subir un libro .xlsx o un .csv como fuente de datos',
    description:
      `Cada hoja con datos se convierte en una tabla: la fila 1 son los encabezados y la columna 1 el identificador de ` +
      `cada registro. Máximo 10 MB y ${EXCEL_MAX_ROWS} registros. El id devuelto funciona como conexionId en el explorador, ` +
      'el editor de consultas y las exportaciones.',
  })
  @ApiCreatedResponse({ type: ExcelFileResponseDto })
  @ApiResponse({ status: 400, description: 'Archivo ausente, dañado, sin datos o con un formato no admitido.' })
  @ApiResponse({ status: 413, description: 'El archivo supera 10 MB.' })
  upload(@Req() request: AuthenticatedRequest, @UploadedFile() file: UploadedExcelFile | undefined, @Body() fields: UploadExcelFieldsDto) {
    return this.excel.upload(request.user, file, fields.nombre, this.auditContext(request));
  }

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Put(':id/archivo')
  @RequirePermission('MANAGE_EXCEL')
  @UseInterceptors(EXCEL_UPLOAD)
  @ApiConsumes('multipart/form-data')
  @ApiBody(UPLOAD_SCHEMA)
  @ApiOperation({ summary: 'Reemplazar el contenido del Excel conservando su id (los reportes que lo usan siguen funcionando)' })
  @ApiOkResponse({ type: ExcelFileResponseDto })
  replace(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @UploadedFile() file: UploadedExcelFile | undefined,
  ) {
    return this.excel.replace(request.user, id, file, this.auditContext(request));
  }

  @Patch(':id')
  @RequirePermission('MANAGE_EXCEL')
  @ApiOperation({ summary: 'Renombrar un archivo de Excel' })
  @ApiOkResponse({ type: ExcelFileResponseDto })
  rename(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string, @Body() input: RenameExcelDto) {
    return this.excel.rename(request.user, id, input.nombre);
  }

  @Delete(':id')
  @RequirePermission('MANAGE_EXCEL')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Eliminar un archivo de Excel (los reportes que lo usan dejarán de ejecutarse)' })
  @ApiNoContentResponse()
  remove(@Req() request: AuthenticatedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.excel.remove(request.user, id, this.auditContext(request));
  }

  private auditContext(request: AuthenticatedRequest) {
    return { ipAddress: request.ip, userAgent: request.get('user-agent') };
  }
}
