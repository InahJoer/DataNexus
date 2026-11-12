-- Datos de ejemplo de DataNexus (issue #49). Generados de forma determinista: los mismos en cada entorno.
-- ERP: clientes. Lo ejecuta el servicio sqlserver-init de docker-compose.
IF DB_ID(N'erp') IS NULL CREATE DATABASE erp;
GO
USE erp;
GO
IF OBJECT_ID(N'dbo.clientes', N'U') IS NOT NULL DROP TABLE dbo.clientes;
GO
CREATE TABLE dbo.clientes (
  id INT NOT NULL PRIMARY KEY,
  nombre NVARCHAR(120) NOT NULL,
  email NVARCHAR(160) NOT NULL,
  telefono NVARCHAR(30) NOT NULL,
  pais CHAR(2) NOT NULL,
  segmento NVARCHAR(20) NOT NULL,
  fecha_alta DATE NOT NULL
);
GO
INSERT INTO dbo.clientes (id, nombre, email, telefono, pais, segmento, fecha_alta) VALUES
  (1, N'Ana Martínez', N'ana.martinez@correo-demo.com', N'+505 8221-6234', 'CR', N'Pyme', '2025-01-23'),
  (2, N'Luis Gómez', N'luis.gomez@correo-demo.com', N'+505 8614-9385', 'HN', N'Particular', '2025-02-05'),
  (3, N'María Núñez', N'maria.nunez@correo-demo.com', N'+505 8762-2681', 'SV', N'Empresa', '2025-02-18'),
  (4, N'Carlos Rivas', N'carlos.rivas@correo-demo.com', N'+505 8328-7891', 'GT', N'Pyme', '2025-03-03'),
  (5, N'Sofía Herrera', N'sofia.herrera@correo-demo.com', N'+505 8902-9975', 'PA', N'Particular', '2025-03-16'),
  (6, N'Jorge Castillo', N'jorge.castillo@correo-demo.com', N'+505 8962-9042', 'NI', N'Empresa', '2025-03-29'),
  (7, N'Valeria Ruiz', N'valeria.ruiz@correo-demo.com', N'+505 8869-8226', 'CR', N'Pyme', '2025-04-11'),
  (8, N'Diego López', N'diego.lopez@correo-demo.com', N'+505 8345-1041', 'HN', N'Particular', '2025-04-24'),
  (9, N'Camila Torres', N'camila.torres@correo-demo.com', N'+505 8728-2322', 'SV', N'Empresa', '2025-05-07'),
  (10, N'Andrés Morales', N'andres.morales@correo-demo.com', N'+505 8213-5706', 'GT', N'Pyme', '2025-05-20'),
  (11, N'Isabella Vargas', N'isabella.vargas@correo-demo.com', N'+505 8936-2606', 'PA', N'Particular', '2025-06-02'),
  (12, N'Mateo Sánchez', N'mateo.sanchez@correo-demo.com', N'+505 8560-1188', 'NI', N'Empresa', '2025-06-15'),
  (13, N'Lucía Romero', N'lucia.romero@correo-demo.com', N'+505 8934-9032', 'CR', N'Pyme', '2025-06-28'),
  (14, N'Gabriel Ortiz', N'gabriel.ortiz@correo-demo.com', N'+505 8795-6148', 'HN', N'Particular', '2025-07-11'),
  (15, N'Daniela Cruz', N'daniela.cruz@correo-demo.com', N'+505 8315-7508', 'SV', N'Empresa', '2025-07-24'),
  (16, N'Sebastián Flores', N'sebastian.flores@correo-demo.com', N'+505 8357-6696', 'GT', N'Pyme', '2025-08-06'),
  (17, N'Paula Medina', N'paula.medina@correo-demo.com', N'+505 8465-7166', 'PA', N'Particular', '2025-08-19'),
  (18, N'Fernando Rojas', N'fernando.rojas@correo-demo.com', N'+505 8863-9414', 'NI', N'Empresa', '2025-09-01'),
  (19, N'Natalia Castro', N'natalia.castro@correo-demo.com', N'+505 8753-2250', 'CR', N'Pyme', '2025-09-14'),
  (20, N'Ricardo Aguilar', N'ricardo.aguilar@correo-demo.com', N'+505 8840-6577', 'HN', N'Particular', '2025-09-27'),
  (21, N'Elena Navarro', N'elena.navarro@correo-demo.com', N'+505 8191-9815', 'SV', N'Empresa', '2025-10-10'),
  (22, N'Tomás Delgado', N'tomas.delgado@correo-demo.com', N'+505 8399-5712', 'GT', N'Pyme', '2025-10-23'),
  (23, N'Adriana Peña', N'adriana.pena@correo-demo.com', N'+505 8568-3308', 'PA', N'Particular', '2025-11-05'),
  (24, N'Hugo Salazar', N'hugo.salazar@correo-demo.com', N'+505 8997-6062', 'NI', N'Empresa', '2025-11-18');
GO
