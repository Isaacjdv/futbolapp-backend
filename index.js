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
        created_at TIMESTZ DEFAULT NOW()
      );

      -- 2. Tabla de Equipos (Para la tienda)
      CREATE TABLE IF NOT EXISTS equipos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL UNIQUE,
        logo_url VARCHAR(255)
      );

      -- 3. Tabla de Productos (Camisetas de la tienda)
      CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        descripcion TEXT,
        precio DECIMAL(10, 2) NOT NULL,
        imagen_url VARCHAR(255),
        stock INT DEFAULT 10,
        equipo_id INT REFERENCES equipos(id)
      );

      -- 4. Tabla del Carrito de Compras (Lo que va a comprar AHORA)
      CREATE TABLE IF NOT EXISTS carrito (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id INT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
        cantidad INT NOT NULL DEFAULT 1,
        UNIQUE(usuario_id, producto_id)
      );
      
      -- 5. ¡NUEVO! Preferencias del Usuario (Para el Home)
      CREATE TABLE IF NOT EXISTS preferencias_usuario (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
        equipo_favorito_id INT, -- El ID que viene de la API-Football
        equipo_favorito_nombre VARCHAR(100),
        equipo_favorito_logo VARCHAR(255)
      );

      -- 6. ¡NUEVO! Camisetas Guardadas (Wishlist)
      CREATE TABLE IF NOT EXISTS camisetas_guardadas (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id INT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
        UNIQUE(usuario_id, producto_id) -- No puede guardar la misma camiseta dos veces
      );
    `;
    
    await client.query(createTablesQuery);
    console.log('¡Todas las tablas (incluyendo preferencias y guardados) han sido creadas/verificadas!');
    
    // Cargar datos de ejemplo (camisetas)
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
    const resEquipos = await client.query('SELECT COUNT(*) FROM equipos');
    if (resEquipos.rows[0].count > 0) {
      console.log('La base de datos (tienda) ya tiene datos de ejemplo.');
      return;
    }

    console.log('Base de datos vacía. Cargando datos de ejemplo (tienda)...');
    
    await client.query(`
      INSERT INTO equipos (nombre, logo_url) VALUES
      ('LDU Quito', 'https://upload.wikimedia.org/wikipedia/commons/2/2e/LDU_Quito_logo_2023.svg'),
      ('Barcelona SC', 'https://upload.wikimedia.org/wikipedia/commons/6/65/Escudo_de_Barcelona_Sporting_Club.svg');
    `);

    await client.query(`
      INSERT INTO productos (nombre, descripcion, precio, imagen_url, equipo_id) VALUES
      ('Camiseta LDU Quito (Local) 2025', 'La nueva camiseta titular.', 59.99, 'https://i.imgur.com/ejkwi4m.png', 1),
      ('Camiseta Barcelona SC (Local) 2025', 'La gloriosa camiseta del Ídolo.', 59.99, 'https://i.imgur.com/O1n3f0W.png', 2);
    `);
    
    console.log('¡Datos de ejemplo de la tienda cargados con éxito!');
  } catch (error) {
    console.error('Error al cargar datos de ejemplo (seed):', error);
  }
}

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- Middleware de Autenticación (para proteger rutas) ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; 
  if (token == null) return res.status(401).json({ message: "Token requerido." });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: "Token inválido." });
    req.user = user; 
    next();
  });
}

// --- Rutas de Autenticación (Login / Registro) ---
// (Son las mismas que ya tenías, no las pego para ahorrar espacio, pero van aquí)
app.post('/auth/register', async (req, res) => { /* ... TU CÓDIGO DE REGISTRO ... */ });
app.post('/auth/login', async (req, res) => { /* ... TU CÓDIGO DE LOGIN ... */ });


// --- Rutas de la Tienda (Camisetas de tu BD) ---
app.get('/api/equipos-tienda', authenticateToken, async (req, res) => { /* ... TU CÓDIGO ... */ });
app.get('/api/productos', authenticateToken, async (req, res) => { /* ... TU CÓDIGO ... */ });
app.get('/api/carrito', authenticateToken, async (req, res) => { /* ... TU CÓDIGO ... */ });
app.post('/api/carrito/add', authenticateToken, async (req, res) => { /* ... TU CÓDIGO ... */ });

// --- ¡NUEVAS RUTAS DE PREFERENCIAS! ---

// GET /api/preferencias - Revisa si el usuario tiene equipo favorito
app.get('/api/preferencias', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM preferencias_usuario WHERE usuario_id = $1',
      [req.user.userId]
    );
    if (result.rows.length > 0) {
      res.json(result.rows[0]); // Devuelve el equipo favorito
    } else {
      res.json(null); // No tiene equipo favorito
    }
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener preferencias', error: error.message });
  }
});

// POST /api/preferencias - Guarda el equipo favorito del usuario
app.post('/api/preferencias', authenticateToken, async (req, res) => {
  const { equipo_id, nombre, logo } = req.body;
  if (!equipo_id || !nombre || !logo) {
    return res.status(400).json({ message: 'Se requiere ID, nombre y logo del equipo.' });
  }
  try {
    // "ON CONFLICT" actualiza si ya existe, o inserta si es nuevo
    const result = await pool.query(
      `INSERT INTO preferencias_usuario (usuario_id, equipo_favorito_id, equipo_favorito_nombre, equipo_favorito_logo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario_id) DO UPDATE SET
         equipo_favorito_id = $2,
         equipo_favorito_nombre = $3,
         equipo_favorito_logo = $4
       RETURNING *`,
      [req.user.userId, equipo_id, nombre, logo]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar preferencia', error: error.message });
  }
});

// --- ¡NUEVAS RUTAS DE CAMISETAS GUARDADAS (Wishlist)! ---

// GET /api/camisetas-guardadas
app.get('/api/camisetas-guardadas', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.* FROM camisetas_guardadas cs
       JOIN productos p ON cs.producto_id = p.id
       WHERE cs.usuario_id = $1`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener camisetas guardadas', error: error.message });
  }
});

// POST /api/camisetas-guardadas
app.post('/api/camisetas-guardadas', authenticateToken, async (req, res) => {
  const { producto_id } = req.body;
  if (!producto_id) {
    return res.status(400).json({ message: 'Se requiere producto_id.' });
  }
  try {
    await pool.query(
      'INSERT INTO camisetas_guardadas (usuario_id, producto_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.userId, producto_id]
    );
    res.status(201).json({ message: 'Camiseta guardada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar camiseta', error: error.message });
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

// --- IMPORTANTE: Pega aquí tus rutas de Login, Registro y Tienda que ya tenías ---
// (No las pego de nuevo para no hacer esto gigantesco,
// pero son las mismas que ya tenías en tu archivo original)