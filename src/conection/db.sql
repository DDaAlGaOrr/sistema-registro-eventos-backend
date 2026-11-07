
CREATE DATABASE IF NOT EXISTS registro_usuarios_evento;
USE registro_usuarios_evento;
-- ============================================================
-- Base de datos: Registro al Congreso (FESJA)
-- ============================================================

CREATE TABLE eventos (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  nombre        VARCHAR(150)  NOT NULL,
  fecha_inicio  DATE          NOT NULL,
  fecha_fin     DATE          NOT NULL,
  lugar         VARCHAR(200),
  activo        BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- Catálogo de conferencias (se administra desde el panel)
-- ------------------------------------------------------------
CREATE TABLE conferencias (
  id      INT AUTO_INCREMENT PRIMARY KEY,
  nombre  VARCHAR(150) NOT NULL,
  codigo  VARCHAR(20)  NOT NULL UNIQUE,  -- Ej: "AZ", "CA-SUR"
  activa  BOOLEAN      NOT NULL DEFAULT TRUE
);

-- Datos iniciales de ejemplo
INSERT INTO conferencias (id, nombre, codigo) VALUES
  (1, 'Arizona Conference', 'AZ'),
  (2, 'Central California Conference', 'CCC'),
  (3, 'Hawaii Conference', 'HIC'),
  (4, 'Nevada-Utah Conference', 'NUC'),
  (5, 'Northern California Conference', 'NCC'),
  (6, 'Southeastern California Conference', 'SECC'),
  (7, 'Southern California Conference', 'SCC');


CREATE TABLE estados (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL,
  codigo VARCHAR(10)  NOT NULL UNIQUE -- Ej: CA, AZ, NV
);

INSERT INTO estados (id, nombre, codigo) VALUES
  (1, 'California', 'CA'),
  (2, 'Arizona', 'AZ'),
  (3, 'Nevada', 'NV'),
  (4, 'Utah', 'UT'),
  (5, 'Hawaii', 'HI');
  
  CREATE TABLE conferencia_estado (
  conferencia_id INT NOT NULL,
  estado_id      INT NOT NULL,
  PRIMARY KEY (conferencia_id, estado_id),
  CONSTRAINT fk_ce_conferencia FOREIGN KEY (conferencia_id) REFERENCES conferencias(id) ON DELETE CASCADE,
  CONSTRAINT fk_ce_estado FOREIGN KEY (estado_id) REFERENCES estados(id) ON DELETE CASCADE
);

INSERT INTO conferencia_estado (conferencia_id, estado_id) VALUES
  (1, 2), -- Arizona Conference -> Arizona
  (2, 1), -- Central California -> California
  (3, 5), -- Hawaii Conference -> Hawaii
  
  -- La Nevada-Utah Conference se relaciona con DOS estados
  (4, 3), -- Nevada-Utah -> Nevada
  (4, 4), -- Nevada-Utah -> Utah
  
  (5, 1), -- Northern California -> California
  (6, 1), -- Southeastern California -> California
  (7, 1); 
-- ------------------------------------------------------------
-- Catálogo de tallas de camiseta
-- ------------------------------------------------------------
CREATE TABLE tallas_camiseta (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  talla       VARCHAR(10)  NOT NULL UNIQUE,  -- XS, S, M, L, XL, XXL
  descripcion VARCHAR(50)
);

INSERT INTO tallas_camiseta (talla, descripcion) VALUES
  ('XS',  'Extra Small'),
  ('S',   'Small'),
  ('M',   'Medium'),
  ('L',   'Large'),
  ('XL',  'Extra Large'),
  ('XXL', 'Double Extra Large');

-- ------------------------------------------------------------
-- Registros de asistentes
-- ------------------------------------------------------------
CREATE TABLE registros (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  evento_id           INT          NOT NULL,
  conferencia_id      INT          NOT NULL,
  talla_camiseta_id   INT,

  -- Datos personales
  nombre              VARCHAR(100) NOT NULL,
  apellidos           VARCHAR(100) NOT NULL,
  correo              VARCHAR(150) NOT NULL,
  telefono            VARCHAR(30),
  fecha_nacimiento    DATE,
  genero              ENUM('Masculino','Femenino','Prefiero no decir'),

  -- Datos de domicilio (ingresados manualmente o por API)
  estado_id             INT NULL,  -- Estado de EE.UU.
  ciudad            	VARCHAR(250),
  iglesia             VARCHAR(200),  -- Nombre libre

  -- Opciones adicionales
  incluir_lunchtime   BOOLEAN      NOT NULL DEFAULT FALSE,
  es_chaperon         BOOLEAN      NOT NULL DEFAULT FALSE,

pago_camiseta       ENUM('pendiente','pagado','no_aplica') NOT NULL DEFAULT 'no_aplica',
pago_lunchtime      ENUM('pendiente','pagado','no_aplica') NOT NULL DEFAULT 'no_aplica',
checkin_at TIMESTAMP NULL DEFAULT NULL,
  created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
                      ON UPDATE CURRENT_TIMESTAMP,


  CONSTRAINT fk_registro_evento
    FOREIGN KEY (evento_id)       REFERENCES eventos(id),
  CONSTRAINT fk_registro_conferencia
    FOREIGN KEY (conferencia_id)  REFERENCES conferencias(id),
  CONSTRAINT fk_registro_talla
    FOREIGN KEY (talla_camiseta_id) REFERENCES tallas_camiseta(id),
  CONSTRAINT fk_registro_estado 
	FOREIGN KEY (estado_id) REFERENCES estados(id)

);

-- Índice útil para búsquedas por correo dentro de un evento
CREATE INDEX idx_registros_correo_evento ON registros (correo, evento_id);

-- ------------------------------------------------------------
-- Contacto de emergencia (1-a-1 con registros)
-- ------------------------------------------------------------
CREATE TABLE contactos_emergencia (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  registro_id       INT          NOT NULL UNIQUE,
  nombre_contacto   VARCHAR(150) NOT NULL,
  telefono_contacto VARCHAR(30)  NOT NULL,
  relacion          VARCHAR(80),  -- Padre, Madre, Familiar, etc.

  CONSTRAINT fk_contacto_registro
    FOREIGN KEY (registro_id) REFERENCES registros(id)
    ON DELETE CASCADE
);



-- ------------------------------------------------------------
-- 2. Tabla de usuarios admin
-- ------------------------------------------------------------
CREATE TABLE admins (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  nombre       VARCHAR(100) NOT NULL,
  correo       VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  rol          ENUM('superadmin','staff') NOT NULL DEFAULT 'staff',
  activo       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 3. Log de check-ins
--    Registra quién hizo el check-in y a qué hora.
--    Útil cuando hay varios admins en la entrada del evento.
-- ------------------------------------------------------------
CREATE TABLE log_checkins (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  registro_id  INT NOT NULL,
  admin_id     INT NOT NULL,
  checkin_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_checkin_registro
    FOREIGN KEY (registro_id) REFERENCES registros(id),
  CONSTRAINT fk_checkin_admin
    FOREIGN KEY (admin_id) REFERENCES admins(id)
);

-- ------------------------------------------------------------
-- 4. Log de cambios de pago
--    Auditoría: quién marcó como pagado y cuándo.
-- ------------------------------------------------------------
CREATE TABLE log_pagos (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  registro_id  INT NOT NULL,
  admin_id     INT NOT NULL,
  concepto     ENUM('camiseta','lunchtime') NOT NULL,
  estatus_nuevo  ENUM('pendiente','pagado','no_aplica')  NOT NULL,
  cambiado_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notas        VARCHAR(200) NULL,

  CONSTRAINT fk_pago_registro
    FOREIGN KEY (registro_id) REFERENCES registros(id),
  CONSTRAINT fk_pago_admin
    FOREIGN KEY (admin_id)    REFERENCES admins(id)
);

-- ------------------------------------------------------------
-- Índices útiles para el panel admin
-- ------------------------------------------------------------

-- Buscar rápido quién ya hizo check-in en un evento
CREATE INDEX idx_registros_checkin   ON registros (evento_id, checkin_at);

-- Filtrar por estatus de pagos pendientes
CREATE INDEX idx_registros_pagos     ON registros (evento_id, pago_camiseta, pago_lunchtime);