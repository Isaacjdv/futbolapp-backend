// Cargar variables de entorno (del archivo .env)
require('dotenv').config();

// --- Importar Librerías ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); // Para nuestros tokens de sesión
const bcrypt = require('bcrypt'); // Para encriptar contraseñas

// --- Configuración ---
const app = express();
const PORT = process.env.PORT || 3001;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- Inicialización de la BD (¡Todas las tablas!) ---
async function initializeDatabase() {
  console.log('Verificando la estructura de la base de datos (PostgreSQL)...');
  const client = await pool.connect();
  try {
    const createTablesQuery = `
      -- 1. Tabla de Usuarios (limpia)
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 2. Tabla de Equipos
      CREATE TABLE IF NOT EXISTS equipos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL UNIQUE,
        logo_url VARCHAR(255)
      );

      -- 3. Tabla de Productos (Camisetas)
      CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        descripcion TEXT,
        precio DECIMAL(10, 2) NOT NULL,
        imagen_url VARCHAR(255),
        stock INT DEFAULT 10,
        equipo_id INT REFERENCES equipos(id) -- Llave foránea a Equipos
      );

      -- 4. Tabla del Carrito de Compras
      CREATE TABLE IF NOT EXISTS carrito (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id INT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
        cantidad INT NOT NULL DEFAULT 1,
        UNIQUE(usuario_id, producto_id) -- Un usuario solo puede tener un producto una vez
      );
    `;
    
    await client.query(createTablesQuery);
    console.log('¡Todas las tablas (usuarios, equipos, productos, carrito) han sido creadas/verificadas!');
    
    // --- FUNCIÓN "INGÉNIATE": Cargar datos de ejemplo ---
    await seedDatabase(client);

  } catch (err) {
    console.error('Error al inicializar la base de datos:', err.stack);
  } finally {
    client.release();
  }
}

// --- Cargar datos de ejemplo (SOLO SI ESTÁ VACÍO) ---
async function seedDatabase(client) {
  try {
    // Revisar si ya hay equipos
    const resEquipos = await client.query('SELECT COUNT(*) FROM equipos');
    if (resEquipos.rows[0].count > 0) {
      console.log('La base de datos ya tiene datos de ejemplo. Omitiendo "seed".');
      return;
    }

    console.log('Base de datos vacía. Cargando datos de ejemplo (seed)...');
    
    // 1. Insertar Equipos
    await client.query(`
      INSERT INTO equipos (nombre, logo_url) VALUES
      ('LDU Quito', 'https://upload.wikimedia.org/wikipedia/commons/2/2e/LDU_Quito_logo_2023.svg'),
      ('Barcelona SC', 'https://upload.wikimedia.org/wikipedia/commons/6/65/Escudo_de_Barcelona_Sporting_Club.svg'),
      ('Independiente del Valle', 'https://upload.wikimedia.org/wikipedia/commons/e/e8/Escudo_Independiente_del_Valle.svg');
    `);

    // 2. Insertar Productos (Camisetas)
    await client.query(`
      INSERT INTO productos (nombre, descripcion, precio, imagen_url, equipo_id) VALUES
      ('Camiseta LDU Quito (Local) 2025', 'La nueva camiseta titular del Rey de Copas.', 59.99, 'https://i.imgur.com/ejkwi4m.png', 1),
      ('Camiseta LDU Quito (Alterna) 2025', 'Camiseta alterna color azul/rey.', 55.00, 'https://i.imgur.com/ejkwi4m.png', 1),
      ('Camiseta Barcelona SC (Local) 2025', 'La gloriosa camiseta del Ídolo.', 59.99, 'https://i.imgur.com/O1n3f0W.png', 2),
      ('Camiseta Barcelona SC (Alterna) 2025', 'Camiseta alterna color rosado.', 55.00, 'https://i.imgur.com/O1n3f0W.png', 2),
      ('Camiseta IDV (Local) 2025', 'La camiseta de los "Rayados del Valle".', 50.00, 'https://i.imgur.com/w992k2F.png', 3);
    `);
    
    console.log('¡Datos de ejemplo cargados con éxito!');

  } catch (error) {
    console.error('Error al cargar datos de ejemplo (seed):', error);
  }
}


// --- Middlewares ---
app.use(cors());
app.use(express.json()); // Muy importante para recibir datos de la app

// --- Middleware de Autenticación (para proteger rutas) ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

  if (token == null) {
    return res.status(401).json({ message: "Token requerido. Acceso denegado." });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ message: "Token inválido." });
    }
    // Añadimos los datos del usuario (del token) al request
    req.user = user; 
    next();
  });
}


// --- Rutas de Autenticación (Sin cambios) ---
app.post('/auth/register', async (req, res) => { /* ... (código de registro de la respuesta anterior) ... */ });
app.post('/auth/login', async (req, res) => { /* ... (código de login de la respuesta anterior) ... */ });

// --- Rutas de API (¡NUEVO!) ---

// GET /api/equipos - Obtener todos los equipos (Público)
app.get('/api/equipos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM equipos ORDER BY nombre ASC');
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener equipos', error: error.message });
  }
});

// GET /api/productos - Obtener todas las camisetas (Público)
app.get('/api/productos', async (req, res) => {
  try {
    // Opcional: filtrar por equipo
    const { equipo_id } = req.query;
    let query = 'SELECT p.*, e.nombre as equipo_nombre FROM productos p JOIN equipos e ON p.equipo_id = e.id';
    
    if (equipo_id) {
      query += ' WHERE p.equipo_id = $1';
      const result = await pool.query(query, [equipo_id]);
      res.json(result.rows);
    } else {
      query += ' ORDER BY p.equipo_id';
      const result = await pool.query(query);
      res.json(result.rows);
    }
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos', error: error.message });
  }
});

// --- Rutas del Carrito (¡Protegidas!) ---

// GET /api/carrito - Ver mi carrito
app.get('/api/carrito', authenticateToken, async (req, res) => {
  try {
    const usuario_id = req.user.userId;
    const result = await pool.query(
      `SELECT c.id as carrito_id, c.cantidad, p.* FROM carrito c
       JOIN productos p ON c.producto_id = p.id
       WHERE c.usuario_id = $1`,
      [usuario_id]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener carrito', error: error.message });
  }
});

// POST /api/carrito/add - Añadir al carrito
app.post('/api/carrito/add', authenticateToken, async (req, res) => {
  const { producto_id, cantidad } = req.body;
  const usuario_id = req.user.userId;

  if (!producto_id || !cantidad) {
    return res.status(400).json({ message: 'Producto y cantidad requeridos.' });
  }

  try {
    // Usamos "ON CONFLICT" para sumar la cantidad si el producto ya está en el carrito
    const result = await pool.query(
      `INSERT INTO carrito (usuario_id, producto_id, cantidad)
       VALUES ($1, $2, $3)
       ON CONFLICT (usuario_id, producto_id)
       DO UPDATE SET cantidad = carrito.cantidad + $3
       RETURNING *`,
      [usuario_id, producto_id, cantidad]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al añadir al carrito', error: error.message });
  }
});


// --- Iniciar el Servidor ---
async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('Fallo al iniciar el servidor:', error);
  }
}

startServer();

// --- Copia y pega el código de las rutas /auth/register y /auth/login de la respuesta anterior aquí ---
// (No los pego de nuevo para no hacer el bloque de código tan largo, 
// pero son exactamente los mismos que te pasé en la respuesta anterior)