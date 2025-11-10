// Cargar variables de entorno (del archivo .env)
require('dotenv').config();

// --- Importar Librerías ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcrypt'); 
const axios = require('axios'); // Necesario para la API de fútbol

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
      -- 1. Tabla de Usuarios
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

      -- 4. Tabla del Carrito de Compras
      CREATE TABLE IF NOT EXISTS carrito (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id INT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
        cantidad INT NOT NULL DEFAULT 1,
        UNIQUE(usuario_id, producto_id)
      );
      
      -- 5. Preferencias del Usuario (equipo favorito de la API de fútbol)
      CREATE TABLE IF NOT EXISTS preferencias_usuario (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
        equipo_favorito_id INT, -- ID de API-Football
        equipo_favorito_nombre VARCHAR(100),
        equipo_favorito_logo VARCHAR(255)
      );

      -- 6. Camisetas Guardadas (Wishlist)
      CREATE TABLE IF NOT EXISTS camisetas_guardadas (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id INT NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
        UNIQUE(usuario_id, producto_id)
      );
    `;
    
    await client.query(createTablesQuery);
    console.log('¡Todas las tablas (incluyendo preferencias y guardados) han sido creadas/verificadas!');
    
    await seedDatabase(client);

  } catch (err) {
    console.error('Error al inicializar la base de datos:', err.stack);
  } finally {
    client.release();
  }
}

// --- Cargar datos de ejemplo (Tienda) ---
async function seedDatabase(client) {
  try {
    const resEquipos = await client.query('SELECT COUNT(*) FROM equipos');
    if (resEquipos.rows[0].count > 0) return; // Si ya hay datos, salir

    console.log('Cargando datos de ejemplo (tienda)...');
    
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

// --- Rutas de Autenticación ---

app.post('/auth/register', async (req, res) => {
  try {
    const { nombre, email, password } = req.body;
    if (!nombre || !email || !password) {
      return res.status(400).json({ message: "Nombre, email y contraseña son requeridos." });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const newUserResult = await pool.query(
      'INSERT INTO usuarios (nombre, email, password) VALUES ($1, $2, $3) RETURNING id, nombre, email',
      [nombre, email, passwordHash]
    );
    const usuario = newUserResult.rows[0];

    const token = jwt.sign({ userId: usuario.id, email: usuario.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ message: "Usuario registrado con éxito", token, usuario });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: "El correo electrónico ya está registrado." });
    }
    console.error('Error en /auth/register:', error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: "Email y contraseña son requeridos." });
    }

    const userResult = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Credenciales incorrectas." });
    }

    const usuario = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, usuario.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Credenciales incorrectas." });
    }

    const token = jwt.sign({ userId: usuario.id, email: usuario.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({
      message: "Inicio de sesión exitoso",
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email }
    });
  } catch (error) {
    console.error('Error en /auth/login:', error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});


// --- Rutas de Tienda y Carrito ---
app.get('/api/productos', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT p.*, e.nombre as equipo_nombre FROM productos p JOIN equipos e ON p.equipo_id = e.id');
  res.json(result.rows);
});

app.post('/api/carrito/add', authenticateToken, async (req, res) => {
  const { producto_id, cantidad } = req.body;
  const usuario_id = req.user.userId;
  const result = await pool.query(
    `INSERT INTO carrito (usuario_id, producto_id, cantidad)
     VALUES ($1, $2, $3)
     ON CONFLICT (usuario_id, producto_id)
     DO UPDATE SET cantidad = carrito.cantidad + $3
     RETURNING *`,
    [usuario_id, producto_id, cantidad || 1]
  );
  res.status(201).json(result.rows[0]);
});

app.get('/api/carrito', authenticateToken, async (req, res) => {
  const result = await pool.query(
    `SELECT c.id as carrito_id, c.cantidad, p.* FROM carrito c
     JOIN productos p ON c.producto_id = p.id
     WHERE c.usuario_id = $1`,
    [req.user.userId]
  );
  res.json(result.rows);
});

// --- Rutas de Preferencias (Guardar Equipo Favorito) ---

app.get('/api/preferencias', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM preferencias_usuario WHERE usuario_id = $1',
      [req.user.userId]
    );
    res.json(result.rows.length > 0 ? result.rows[0] : null); 
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener preferencias', error: error.message });
  }
});

app.post('/api/preferencias', authenticateToken, async (req, res) => {
  const { equipo_id, nombre, logo } = req.body;
  if (!equipo_id || !nombre || !logo) {
    return res.status(400).json({ message: 'Se requiere ID, nombre y logo del equipo.' });
  }
  try {
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

// --- Rutas de Wishlist (Camisetas Guardadas) ---

app.get('/api/camisetas-guardadas', authenticateToken, async (req, res) => {
  const result = await pool.query(
    `SELECT p.* FROM camisetas_guardadas cs
     JOIN productos p ON cs.producto_id = p.id
     WHERE cs.usuario_id = $1`,
    [req.user.userId]
  );
  res.json(result.rows);
});


// --- ¡NUEVA RUTA DE PROXY PARA LA API DE FÚTBOL! ---

app.get('/api/equipos-liga-pro', authenticateToken, async (req, res) => {
  // Las API Keys están en las variables de entorno de Render
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY; 
  const API_HOST = 'api-football-v1.p.rapidapi.com';
  const LEAGUE_ID_ECUADOR = 207; 
  const SEASON = 2024;
  
  if (!RAPIDAPI_KEY) {
    return res.status(500).json({ message: "La API Key de fútbol no está configurada en el servidor." });
  }
  
  try {
    // Usamos la API Key que me diste (a097e1bdd2...) de forma SEGURA desde Render
    const response = await axios.get('https://api-football-v1.p.rapidapi.com/v3/teams', {
      params: { league: LEAGUE_ID_ECUADOR, season: SEASON },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY, 
        'x-rapidapi-host': API_HOST,
      },
    });
    
    // Devolvemos la respuesta directamente a la App Móvil
    res.json(response.data.response);
  } catch (error) {
    console.error('Error al obtener equipos de RapidAPI:', error.response?.data);
    res.status(500).json({ message: 'Error en el servidor al cargar datos de fútbol.', detail: error.message });
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