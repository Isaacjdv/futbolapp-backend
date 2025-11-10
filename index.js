// ===============================
//  BACKEND FUTBOLAPP COMPLETO
//  Sin .env, listo para Render + local
// ===============================

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const axios = require('axios');

// ===============================
//  CONFIGURACIÓN GENERAL
// ===============================

const app = express();
const PORT = process.env.PORT || 3001;

// JWT fijo para fines educativos (puedes cambiarlo)
const JWT_SECRET = 'clave_super_secreta_demo';

// URL LOCAL opcional (para desarrollo en tu PC).
// Si no la usas, déjala vacía. Si la usas, pon tu cadena real.
// EJEMPLO: 'postgres://postgres:1234@localhost:5432/futbolapp'
const LOCAL_DB_URL = ''; // <-- Si trabajas local con Postgres, ponla aquí

// En Render se usa DATABASE_URL (configurada en el panel).
// Si no hay ninguna, tiramos error claro.
const connectionString = process.env.DATABASE_URL || LOCAL_DB_URL;

if (!connectionString) {
  console.error('❌ No hay DATABASE_URL (Render) ni LOCAL_DB_URL configurada.');
  process.exit(1);
}

// Detecta si estamos en Render para manejar SSL
const IS_RENDER = !!process.env.RENDER;

const pool = new Pool({
  connectionString,
  ssl: IS_RENDER
    ? { rejectUnauthorized: false } // Render / producción
    : false,                        // Local sin SSL
});

// Middlewares globales
app.use(cors());
app.use(express.json());

// ===============================
//  MIDDLEWARE AUTENTICACIÓN
// ===============================

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Token requerido.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Token inválido.' });
    req.user = user;
    next();
  });
}

// ===============================
//  INICIALIZAR BASE DE DATOS
// ===============================

async function initializeDatabase() {
  console.log('Verificando estructura de BD...');
  const client = await pool.connect();
  try {
    const createTablesQuery = `
      -- 1. Usuarios
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- 2. Equipos
      CREATE TABLE IF NOT EXISTS equipos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL UNIQUE,
        logo_url VARCHAR(255)
      );

      -- 3. Productos (local opcional)
      CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        descripcion TEXT,
        precio DECIMAL(10,2) NOT NULL,
        imagen_url VARCHAR(255)
      );

      -- 4. Carrito
      CREATE TABLE IF NOT EXISTS carrito (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id VARCHAR(50) NOT NULL,
        cantidad INT NOT NULL DEFAULT 1,
        nombre_producto VARCHAR(255),
        precio_producto DECIMAL(10,2),
        UNIQUE(usuario_id, producto_id)
      );

      -- 5. Preferencias (País favorito)
      CREATE TABLE IF NOT EXISTS preferencias_usuario (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
        equipo_favorito_nombre VARCHAR(100),
        equipo_favorito_logo VARCHAR(255)
      );

      -- 6. Camisetas Guardadas
      CREATE TABLE IF NOT EXISTS camisetas_guardadas (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id VARCHAR(50) NOT NULL,
        UNIQUE(usuario_id, producto_id)
      );

      -- 7. Platos Guardados
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
    console.log('✅ Tablas listas');

    await seedDatabase(client);
  } catch (err) {
    console.error('Error al inicializar BD:', err);
    throw err;
  } finally {
    client.release();
  }
}

async function seedDatabase(client) {
  try {
    const res = await client.query('SELECT COUNT(*) FROM equipos');
    if (parseInt(res.rows[0].count, 10) > 0) return;

    console.log('Insertando equipos demo...');
    await client.query(`
      INSERT INTO equipos (nombre, logo_url) VALUES
      ('Real Madrid', 'https://upload.wikimedia.org/wikipedia/en/5/56/Real_Madrid_CF.svg'),
      ('FC Barcelona', 'https://upload.wikimedia.org/wikipedia/en/4/47/FC_Barcelona_%28crest%29.svg'),
      ('Boca Juniors', 'https://upload.wikimedia.org/wikipedia/commons/c/c5/Escudo_Boca_Juniors.png');
    `);
  } catch (err) {
    console.error('Error en seedDatabase:', err);
  }
}

// ===============================
//  RUTAS: AUTENTICACIÓN
// ===============================

app.post('/auth/register', async (req, res) => {
  try {
    const { nombre, email, password } = req.body;
    if (!nombre || !email || !password) {
      return res.status(400).json({ message: 'Todos los campos son requeridos.' });
    }

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    const result = await pool.query(
      'INSERT INTO usuarios (nombre, email, password) VALUES ($1,$2,$3) RETURNING id,nombre,email',
      [nombre, email, hash]
    );

    const usuario = result.rows[0];
    const token = jwt.sign(
      { userId: usuario.id, email: usuario.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({ message: 'Registrado con éxito', token, usuario });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'El correo ya está registrado.' });
    }
    console.error(err);
    res.status(500).json({ message: 'Error interno del servidor.' });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM usuarios WHERE email = $1',
      [email]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const usuario = result.rows[0];
    const ok = await bcrypt.compare(password, usuario.password);
    if (!ok) {
      return res.status(401).json({ message: 'Credenciales incorrectas.' });
    }

    const token = jwt.sign(
      { userId: usuario.id, email: usuario.email },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Inicio de sesión exitoso',
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error interno del servidor.' });
  }
});

// ===============================
//  RUTAS: PRODUCTOS / TIENDA
// ===============================

const FAKE_STORE_API_URL = 'https://fakestoreapi.com/products';

const FALLBACK_PRODUCTS = [
  {
    id: '1',
    nombre: 'Jersey Clásico Albiceleste',
    descripcion: 'Camiseta inspirada en la pasión sudamericana.',
    precio: 39.99,
    imagen_url: 'https://images.pexels.com/photos/4108800/pexels-photo-4108800.jpeg',
  },
  {
    id: '2',
    nombre: 'Jersey Andino Edición Limitada',
    descripcion: 'Detalles dorados y colores de la cordillera.',
    precio: 44.99,
    imagen_url: 'https://images.pexels.com/photos/999309/pexels-photo-999309.jpeg',
  },
  {
    id: '3',
    nombre: 'Jersey Negro Alterno',
    descripcion: 'Minimalista, elegante, ideal para cualquier hincha.',
    precio: 34.99,
    imagen_url: 'https://images.pexels.com/photos/7675003/pexels-photo-7675003.jpeg',
  },
  {
    id: '4',
    nombre: 'Jersey Retro 94',
    descripcion: 'Homenaje a las leyendas del fútbol clásico.',
    precio: 49.99,
    imagen_url: 'https://images.pexels.com/photos/1884574/pexels-photo-1884574.jpeg',
  },
];

app.get('/api/productos', authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(FAKE_STORE_API_URL, { timeout: 5000 });
    const data = response.data || [];

    let camisetas = data.slice(0, 12).map((p) => ({
      id: p.id.toString(),
      nombre: `Jersey ${p.category} ${p.title.split(' ').slice(0, 2).join(' ')}`,
      descripcion: p.description,
      precio: p.price,
      imagen_url: p.image,
    }));

    if (!camisetas.length) {
      console.log('API vacía, usando fallback');
      camisetas = FALLBACK_PRODUCTS;
    }

    res.json(camisetas);
  } catch (err) {
    console.error('Error productos API externa:', err.message);
    res.json(FALLBACK_PRODUCTS); // Nunca 500 vacío: siempre damos algo
  }
});

// ===============================
//  RUTAS: CARRITO
// ===============================

app.post('/api/carrito/add', authenticateToken, async (req, res) => {
  const { producto_id, cantidad, nombre_producto, precio_producto } = req.body;
  const usuario_id = req.user.userId;

  if (!producto_id) {
    return res.status(400).json({ message: 'Producto ID requerido.' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO carrito (usuario_id, producto_id, cantidad, nombre_producto, precio_producto)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (usuario_id, producto_id)
       DO UPDATE SET cantidad = carrito.cantidad + $3
       RETURNING *`,
      [
        usuario_id,
        producto_id,
        cantidad || 1,
        nombre_producto || null,
        precio_producto || 0,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error carrito:', err.message);
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
  } catch (err) {
    console.error('Error obtener carrito:', err.message);
    res.status(500).json({ message: 'Error al obtener carrito.' });
  }
});

// ===============================
//  RUTAS: CAMISETAS GUARDADAS
// ===============================

app.get('/api/camisetas-guardadas', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, producto_id
       FROM camisetas_guardadas
       WHERE usuario_id = $1`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('Error obtener camisetas guardadas:', err.message);
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
       VALUES ($1,$2)
       ON CONFLICT (usuario_id, producto_id)
       DO NOTHING
       RETURNING *`,
      [usuario_id, producto_id]
    );

    if (result.rows.length === 0) {
      return res.status(200).json({ message: 'Esta camiseta ya estaba guardada.' });
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error guardar camiseta:', err.message);
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
  } catch (err) {
    console.error('Error eliminar camiseta:', err.message);
    res.status(500).json({ message: 'Error al eliminar camiseta guardada.' });
  }
});

// ===============================
//  RUTAS: PREFERENCIAS (PAÍS)
// ===============================

app.get('/api/preferencias', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM preferencias_usuario WHERE usuario_id = $1',
      [req.user.userId]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    console.error('Error obtener preferencia:', err.message);
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
       VALUES ($1,$2,$3)
       ON CONFLICT (usuario_id)
       DO UPDATE SET
         equipo_favorito_nombre = EXCLUDED.equipo_favorito_nombre,
         equipo_favorito_logo = EXCLUDED.equipo_favorito_logo
       RETURNING *`,
      [req.user.userId, nombre, logo]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error guardar preferencia:', err.message);
    res.status(500).json({ message: 'Error al guardar preferencia.' });
  }
});

// ===============================
//  RUTAS: PAÍSES SUDAMÉRICA
// ===============================

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
    const response = await axios.get(
      'https://restcountries.com/v3.1/subregion/south america'
    );

    const byName = new Map();

    for (const c of response.data || []) {
      const nombreEs = c.translations?.spa?.common || c.name.common;
      if (SA_COUNTRIES.includes(nombreEs)) {
        byName.set(nombreEs, {
          id: c.cca3,
          nombre: nombreEs,
          logo: c.flags?.png || c.flags?.svg || '',
        });
      }
    }

    const lista = SA_COUNTRIES.map((n) => byName.get(n)).filter(Boolean);
    res.json(lista);
  } catch (err) {
    console.error('Error países Sudamérica:', err.message);
    res.status(500).json({ message: 'Error al obtener países.' });
  }
});

// ===============================
//  RUTAS: PLATOS GUARDADOS
// ===============================

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
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (usuario_id, pais, nombre_plato)
       DO NOTHING
       RETURNING *`,
      [usuario_id, pais, nombre_plato, imagen_url || null]
    );

    if (result.rows.length === 0) {
      return res
        .status(200)
        .json({ message: 'Este plato ya estaba guardado.' });
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error guardar plato:', err.message);
    res.status(500).json({ message: 'Error al guardar plato.' });
  }
});

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
  } catch (err) {
    console.error('Error obtener platos:', err.message);
    res.status(500).json({ message: 'Error al obtener platos guardados.' });
  }
});

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
  } catch (err) {
    console.error('Error eliminar plato:', err.message);
    res.status(500).json({ message: 'Error al eliminar plato guardado.' });
  }
});

// ===============================
//  INICIAR SERVIDOR
// ===============================

async function startServer() {
  try {
    await initializeDatabase();
    app.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
    });
  } catch (err) {
    console.error('No se pudo iniciar servidor:', err);
    process.exit(1);
  }
}

startServer();
