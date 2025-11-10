// Cargar variables de entorno (del archivo .env)
require('dotenv').config();

// --- Importar Librerías ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');

// --- Configuración ---
const app = express();
const PORT = process.env.PORT || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// --- Inicialización de la BD (Estructura) ---
async function initializeDatabase() {
  console.log('Verificando la estructura de la base de datos (PostgreSQL)...');
  const client = await pool.connect();
  try {
    const createTablesQuery = `
      -- 1. Tabla de Usuarios
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

      -- 3. Tabla de Productos
      CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        descripcion TEXT,
        precio DECIMAL(10, 2) NOT NULL,
        imagen_url VARCHAR(255)
      );
      
      -- 4. Carrito
      CREATE TABLE IF NOT EXISTS carrito (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id VARCHAR(50) NOT NULL,
        cantidad INT NOT NULL DEFAULT 1,
        nombre_producto VARCHAR(255),
        precio_producto DECIMAL(10, 2),
        UNIQUE(usuario_id, producto_id)
      );
      
      -- 5. Preferencias (País favorito)
      CREATE TABLE IF NOT EXISTS preferencias_usuario (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
        equipo_favorito_nombre VARCHAR(100),
        equipo_favorito_logo VARCHAR(255)
      );

      -- 6. Camisetas Guardadas (Wishlist)
      CREATE TABLE IF NOT EXISTS camisetas_guardadas (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id VARCHAR(50) NOT NULL,
        UNIQUE(usuario_id, producto_id)
      );

      -- 7. Platos guardados por usuario
      CREATE TABLE IF NOT EXISTS platos_guardados (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        pais VARCHAR(100) NOT NULL,
        nombre_plato VARCHAR(255) NOT NULL,
        imagen_url TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(usuario_id, pais, nombre_plato)
      );
    `;
    await client.query(createTablesQuery);
    console.log('¡Estructura de BD verificada!');

    await seedDatabase(client);
  } catch (err) {
    console.error('Error al inicializar la base de datos:', err.stack);
  } finally {
    client.release();
  }
}

// --- Datos iniciales ---
async function seedDatabase(client) {
  try {
    const resEquipos = await client.query('SELECT COUNT(*) FROM equipos');
    if (parseInt(resEquipos.rows[0].count, 10) > 0) return;

    console.log('Cargando equipos base...');
    await client.query(`
      INSERT INTO equipos (nombre, logo_url) VALUES
      ('Real Madrid', 'https://upload.wikimedia.org/wikipedia/en/5/56/Real_Madrid_CF.svg'),
      ('FC Barcelona', 'https://upload.wikimedia.org/wikipedia/en/4/47/FC_Barcelona_%28crest%29.svg'),
      ('Boca Juniors', 'https://upload.wikimedia.org/wikipedia/commons/c/c5/Escudo_Boca_Juniors.png');
    `);
  } catch (error) {
    console.error('Error al cargar datos de ejemplo:', error);
  }
}

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- Auth Middleware ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token requerido.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token inválido.' });
    req.user = user;
    next();
  });
}

/* =====================
   RUTAS DE AUTENTICACIÓN
   ===================== */

app.post('/auth/register', async (req, res) => {
  try {
    const { nombre, email, password } = req.body;
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUserResult = await pool.query(
      'INSERT INTO usuarios (nombre, email, password) VALUES ($1, $2, $3) RETURNING id, nombre, email',
      [nombre, email, passwordHash]
    );

    const usuario = newUserResult.rows[0];
    const token = jwt.sign(
      { userId: usuario.id, email: usuario.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ message: 'Usuario registrado con éxito', token, usuario });
  } catch (error) {
    if (error.code === '23505') {
      return res
        .status(409)
        .json({ message: 'El correo electrónico ya está registrado.' });
    }
    console.error(error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const userResult = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const usuario = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, usuario.password);
    if (!isMatch) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const token = jwt.sign(
      { userId: usuario.id, email: usuario.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      message: 'Inicio de sesión exitoso',
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error interno del servidor' });
  }
});

/* =====================
   TIENDA / PRODUCTOS
   ===================== */

const FAKE_STORE_API_URL = 'https://fakestoreapi.com/products';

app.get('/api/productos', authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(FAKE_STORE_API_URL);

    const camisetas = response.data
      .map((p) => ({
        id: p.id.toString(),
        nombre: `Jersey Oficial ${p.category} ${p.title
          .split(' ')
          .slice(0, 2)
          .join(' ')}`,
        descripcion: p.description,
        precio: p.price,
        imagen_url: p.image,
      }))
      .filter((p) => parseInt(p.id, 10) < 15);

    res.json(camisetas);
  } catch (error) {
    console.error('Error productos tienda:', error.message);
    res.status(500).json({ message: 'Error al cargar productos de la tienda.' });
  }
});

/* =====================
   CARRITO
   ===================== */

app.post('/api/carrito/add', authenticateToken, async (req, res) => {
  const { producto_id, cantidad, nombre_producto, precio_producto } = req.body;
  const usuario_id = req.user.userId;

  if (!producto_id) {
    return res.status(400).json({ message: 'Producto ID requerido.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO carrito (usuario_id, producto_id, cantidad, nombre_producto, precio_producto)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (usuario_id, producto_id)
       DO UPDATE SET cantidad = carrito.cantidad + $3
       RETURNING *`,
      [usuario_id, producto_id, cantidad || 1, nombre_producto, precio_producto]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al añadir al carrito:', error.message);
    res.status(500).json({ message: 'Error al añadir al carrito.' });
  }
});

app.get('/api/carrito', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM carrito WHERE usuario_id = $1',
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener carrito:', error.message);
    res.status(500).json({ message: 'Error al obtener carrito.' });
  }
});

/* =====================
   CAMISETAS GUARDADAS
   ===================== */

app.get('/api/camisetas-guardadas', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, producto_id
       FROM camisetas_guardadas
       WHERE usuario_id = $1`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener camisetas guardadas:', error.message);
    res.status(500).json({ message: 'Error al obtener camisetas guardadas.' });
  }
});

app.post('/api/camisetas-guardadas', authenticateToken, async (req, res) => {
  const { producto_id } = req.body;
  const usuario_id = req.user.userId;

  if (!producto_id) {
    return res.status(400).json({ message: 'Producto ID requerido.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO camisetas_guardadas (usuario_id, producto_id)
       VALUES ($1, $2)
       ON CONFLICT (usuario_id, producto_id)
       DO NOTHING
       RETURNING *`,
      [usuario_id, producto_id]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ message: 'Esta camiseta ya estaba guardada.' });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al guardar camiseta:', error.message);
    res.status(500).json({ message: 'Error al guardar camiseta.' });
  }
});

app.delete('/api/camisetas-guardadas/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM camisetas_guardadas
       WHERE id = $1 AND usuario_id = $2
       RETURNING *`,
      [id, req.user.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Camiseta no encontrada.' });
    }

    res.json({ message: 'Camiseta eliminada.' });
  } catch (error) {
    console.error('Error al eliminar camiseta guardada:', error.message);
    res.status(500).json({ message: 'Error al eliminar camiseta guardada.' });
  }
});

/* =====================
   PREFERENCIAS (PAÍS FAVORITO)
   ===================== */

app.get('/api/preferencias', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM preferencias_usuario WHERE usuario_id = $1',
      [req.user.userId]
    );
    res.json(result.rows.length > 0 ? result.rows[0] : null);
  } catch (error) {
    console.error('Error al obtener preferencia:', error.message);
    res.status(500).json({ message: 'Error al obtener preferencia.' });
  }
});

app.post('/api/preferencias', authenticateToken, async (req, res) => {
  const { nombre, logo } = req.body;
  if (!nombre || !logo) {
    return res
      .status(400)
      .json({ message: 'Nombre y logo del país son requeridos.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO preferencias_usuario (usuario_id, equipo_favorito_nombre, equipo_favorito_logo)
       VALUES ($1, $2, $3)
       ON CONFLICT (usuario_id)
       DO UPDATE SET
         equipo_favorito_nombre = EXCLUDED.equipo_favorito_nombre,
         equipo_favorito_logo = EXCLUDED.equipo_favorito_logo
       RETURNING *`,
      [req.user.userId, nombre, logo]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al guardar preferencia:', error.message);
    res.status(500).json({ message: 'Error al guardar preferencia.' });
  }
});

/* =====================
   EQUIPOS/PAÍSES DE SUDAMÉRICA
   ===================== */

const SA_COUNTRIES = [
  'Argentina',
  'Bolivia',
  'Brasil',
  'Chile',
  'Colombia',
  'Ecuador',
  'Paraguay',
  'Perú',
  'Uruguay',
  'Venezuela',
];

app.get('/api/equipos-del-mundo', authenticateToken, async (req, res) => {
  try {
    // Países de Sudamérica desde restcountries
    const response = await axios.get(
      'https://restcountries.com/v3.1/subregion/south america'
    );

    const mapa = new Map();
    for (const country of response.data) {
      const nombreEs =
        country.translations?.spa?.common || country.name.common;
      if (SA_COUNTRIES.includes(nombreEs)) {
        mapa.set(nombreEs, {
          id: country.cca3,
          nombre: nombreEs,
          logo: country.flags?.png || country.flags?.svg || '',
        });
      }
    }

    // Orden según lista fija
    const paisesSud = SA_COUNTRIES.map((n) => mapa.get(n)).filter(Boolean);

    res.json(paisesSud);
  } catch (error) {
    console.error('Error al obtener países Sudamérica:', error.message);
    res
      .status(500)
      .json({ message: 'Error al obtener países para preferencias.' });
  }
});

/* =====================
   PLATOS GUARDADOS
   ===================== */

// Guardar plato favorito
app.post('/api/platos/guardar', authenticateToken, async (req, res) => {
  const { pais, nombre_plato, imagen_url } = req.body;
  const usuario_id = req.user.userId;

  if (!pais || !nombre_plato) {
    return res
      .status(400)
      .json({ message: 'País y nombre del plato son requeridos.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO platos_guardados (usuario_id, pais, nombre_plato, imagen_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario_id, pais, nombre_plato)
       DO NOTHING
       RETURNING *`,
      [usuario_id, pais, nombre_plato, imagen_url || null]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ message: 'Este plato ya estaba guardado.' });
    }

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al guardar plato:', error.message);
    res.status(500).json({ message: 'Error al guardar plato.' });
  }
});

// Listar platos guardados
app.get('/api/platos', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, pais, nombre_plato, imagen_url, created_at
       FROM platos_guardados
       WHERE usuario_id = $1
       ORDER BY created_at DESC`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener platos guardados:', error.message);
    res.status(500).json({ message: 'Error al obtener platos guardados.' });
  }
});

// Eliminar plato guardado
app.delete('/api/platos/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query(
      'DELETE FROM platos_guardados WHERE id = $1 AND usuario_id = $2 RETURNING *',
      [id, req.user.userId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Plato no encontrado.' });
    }
    res.json({ message: 'Plato eliminado.' });
  } catch (error) {
    console.error('Error al eliminar plato:', error.message);
    res.status(500).json({ message: 'Error al eliminar plato.' });
  }
});

/* =====================
   INICIAR SERVIDOR
   ===================== */

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('Fallo al iniciar el servidor:', error);
    process.exit(1);
  }
}

startServer();
