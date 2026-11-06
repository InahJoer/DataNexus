import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Put,
  Req,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiConsumes,
  ApiBody,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ConnectionsService } from './connections.service.js';
import { CreateConnectionDto } from './dto/create-connection.dto.js';
import { UpdateConnectionDto } from './dto/update-connection.dto.js';
import { ConnectionResponseDto } from './dto/connection-response.dto.js';
import { ConnectionTestOptionsDto, TestConnectionDto } from './dto/test-connection.dto.js';
import { ConnectionTestResultDto } from './dto/connection-test-result.dto.js';
import { ConnectionTestService } from './connection-test.service.js';
import {
  FIRESTORE_UPLOAD_SCHEMA,
  FirestoreUploadFieldsDto,
  SERVICE_ACCOUNT_MAX_BYTES,
  type UploadedServiceAccountFile,
} from './dto/firestore-connection.dto.js';

/**
 * Subida del Service Account: sin `dest` ni `storage`, multer usa almacenamiento en memoria, así que el
 * JSON nunca se escribe en disco. Un archivo por petición y como máximo 64 KB (413 si se supera).
 */
const SERVICE_ACCOUNT_UPLOAD = FileInterceptor('serviceAccount', {
  limits: { fileSize: SERVICE_ACCOUNT_MAX_BYTES, files: 1, fields: 5, parts: 6 },
  fileFilter: (
    _request: unknown,
    file: { originalname: string; mimetype: string },
    callback: (error: Error | null, accept: boolean) => void,
  ) => {
    const isJson = /\.json$/i.test(file.originalname) || /json/i.test(file.mimetype);
    callback(isJson ? null : new BadRequestException('El Service Account debe ser un archivo .json'), isJson);
  },
});
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { RequirePermission } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedRequest } from '../auth/interfaces/authenticated-user.interface.js';

@ApiTags('Connections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly connectionsService: ConnectionsService,
    private readonly connectionTestService: ConnectionTestService,
  ) {}

  @Post()
  @RequirePermission('MANAGE_CONNECTIONS')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crear una conexión con credenciales estructuradas (RF-08)',
    description:
      'El formato de `credenciales` depende de `tipoMotor`. Todo el payload se cifra con AES-256; la respuesta solo trae metadatos.',
  })
  @ApiCreatedResponse({ type: ConnectionResponseDto, description: 'Conexión creada; las credenciales no se devuelven.' })
  @ApiResponse({ status: 400, description: 'Credenciales incompletas, con campos de otro motor o inválidas.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede crear conexiones.' })
  create(@Req() request: AuthenticatedRequest, @Body() input: CreateConnectionDto) {
    return this.connectionsService.create(request.user, input, this.auditContext(request));
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('test')
  @RequirePermission('MANAGE_CONNECTIONS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Probar credenciales antes de guardar la conexión (RF-10)',
    description:
      'Conecta, autentica y consulta la versión del servidor midiendo la latencia. No persiste nada ni devuelve secretos. ' +
      'Un fallo de red o credenciales responde 200 con ok=false y un error normalizado por motor.',
  })
  @ApiOkResponse({ type: ConnectionTestResultDto })
  @ApiResponse({ status: 400, description: 'Datos de conexión inválidos.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede probar credenciales nuevas.' })
  @ApiResponse({ status: 429, description: 'Máximo 10 pruebas por minuto.' })
  testCredentials(@Body() input: TestConnectionDto) {
    return this.connectionTestService.testCredentials(input);
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post(':id/test')
  @RequirePermission('VIEW_CONNECTIONS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Probar una conexión guardada y medir su latencia (RF-10)',
    description:
      'Usa las credenciales cifradas de la conexión sin exponerlas. Un fallo de red o credenciales responde 200 con ok=false.',
  })
  @ApiBody({ type: ConnectionTestOptionsDto, required: false })
  @ApiOkResponse({ type: ConnectionTestResultDto })
  @ApiResponse({ status: 403, description: 'Se requiere rol ADMIN u OPERADOR.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  @ApiResponse({ status: 429, description: 'Máximo 10 pruebas por minuto.' })
  testSaved(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() options: ConnectionTestOptionsDto = {},
  ) {
    return this.connectionTestService.testSaved(request.user, id, options);
  }

  @Post('firestore')
  @RequirePermission('MANAGE_CONNECTIONS')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(SERVICE_ACCOUNT_UPLOAD)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: FIRESTORE_UPLOAD_SCHEMA })
  @ApiOperation({
    summary: 'Crear una conexión Firestore subiendo el JSON de Service Account (RF-09)',
    description:
      'multipart/form-data con el archivo `serviceAccount`. Se valida (type, project_id, private_key, client_email), se cifra y nunca se escribe en disco.',
  })
  @ApiCreatedResponse({ type: ConnectionResponseDto })
  @ApiResponse({ status: 400, description: 'Archivo ausente, no JSON o Service Account inválido.' })
  @ApiResponse({ status: 413, description: 'El archivo supera 64 KB.' })
  createFirestore(
    @Req() request: AuthenticatedRequest,
    @UploadedFile() file: UploadedServiceAccountFile | undefined,
    @Body() fields: FirestoreUploadFieldsDto,
  ) {
    return this.connectionsService.createFirestoreFromUpload(request.user, file, fields, this.auditContext(request));
  }

  @Get()
  @RequirePermission('VIEW_CONNECTIONS')
  @ApiOperation({ summary: 'Listar conexiones del workspace autenticado (ADMIN u OPERADOR)' })
  @ApiOkResponse({ type: ConnectionResponseDto, isArray: true, description: 'Lista segura de conexiones.' })
  @ApiResponse({ status: 403, description: 'Se requiere rol ADMIN u OPERADOR para listar conexiones.' })
  findAll(@Req() request: AuthenticatedRequest) {
    return this.connectionsService.findAll(request.user);
  }

  @Get(':id')
  @RequirePermission('VIEW_CONNECTIONS')
  @ApiOperation({ summary: 'Obtener una conexión del workspace autenticado' })
  @ApiOkResponse({ type: ConnectionResponseDto, description: 'Detalle seguro de la conexión.' })
  @ApiResponse({ status: 403, description: 'Se requiere rol ADMIN u OPERADOR para consultar conexiones.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.connectionsService.findOne(request.user, id);
  }

  @Patch(':id')
  @RequirePermission('MANAGE_CONNECTIONS')
  @ApiOperation({
    summary: 'Actualizar una conexión del workspace autenticado',
    description:
      'Con el mismo motor, `credenciales` puede traer solo los campos que cambian (p. ej. rotar `password`). Cambiar `tipoMotor` exige credenciales completas.',
  })
  @ApiOkResponse({ type: ConnectionResponseDto, description: 'Conexión actualizada y cambio auditado.' })
  @ApiResponse({ status: 400, description: 'Credenciales inválidas o cambio de motor sin credenciales.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede actualizar conexiones.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateConnectionDto,
  ) {
    return this.connectionsService.update(request.user, id, input, this.auditContext(request));
  }

  @Put(':id/service-account')
  @RequirePermission('MANAGE_CONNECTIONS')
  @UseInterceptors(SERVICE_ACCOUNT_UPLOAD)
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: FIRESTORE_UPLOAD_SCHEMA })
  @ApiOperation({
    summary: 'Reemplazar el Service Account de una conexión Firestore',
    description: 'Rotación de claves: sube el nuevo JSON; el anterior deja de usarse. Se procesa en memoria.',
  })
  @ApiOkResponse({ type: ConnectionResponseDto })
  @ApiResponse({ status: 400, description: 'La conexión no es Firestore o el archivo no es válido.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  replaceServiceAccount(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @UploadedFile() file: UploadedServiceAccountFile | undefined,
    @Body() fields: FirestoreUploadFieldsDto,
  ) {
    return this.connectionsService.replaceServiceAccount(request.user, id, file, fields, this.auditContext(request));
  }

  @Delete(':id')
  @RequirePermission('MANAGE_CONNECTIONS')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Eliminar una conexión del workspace autenticado' })
  @ApiResponse({ status: 200, description: 'Conexión eliminada y acción auditada.' })
  @ApiResponse({ status: 403, description: 'Solo ADMIN puede eliminar conexiones.' })
  @ApiResponse({ status: 404, description: 'Conexión no encontrada.' })
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.connectionsService.remove(request.user, id, this.auditContext(request));
  }

  private auditContext(request: AuthenticatedRequest) {
    return {
      ipAddress: request.ip,
      userAgent: request.get('user-agent'),
    };
  }
}
