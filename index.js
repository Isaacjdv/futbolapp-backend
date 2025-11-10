// Cargar variables de entorno (del archivo .env)
require('dotenv').config();

// --- Importar Librerías ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); 
const bcrypt = require('bcrypt'); 
const axios = require('axios'); // Para las APIs públicas

// --- Configuración ---
const app = express();
const PORT = process.env.PORT || 3001;
// Asegúrate de que DATABASE_URL esté definida en tu .env
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
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
        created_at TIMESTZ DEFAULT NOW()
      );

      -- 2. Tabla de Equipos (Base local para simulación de favoritos)
      CREATE TABLE IF NOT EXISTS equipos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL UNIQUE,
        logo_url VARCHAR(255)
      );

      -- 3. Tabla de Productos (Tienda local - IDs de la API Externa)
      CREATE TABLE IF NOT EXISTS productos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(255) NOT NULL,
        descripcion TEXT,
        precio DECIMAL(10, 2) NOT NULL,
        imagen_url VARCHAR(255)
      );
      
      -- 4. Tabla del Carrito de Compras (usa ID externo de producto)
      CREATE TABLE IF NOT EXISTS carrito (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id VARCHAR(50) NOT NULL, 
        cantidad INT NOT NULL DEFAULT 1,
        nombre_producto VARCHAR(255), 
        precio_producto DECIMAL(10, 2),
        UNIQUE(usuario_id, producto_id)
      );
      
      -- 5. Preferencias del Usuario (Equipo/Liga Favorita)
      CREATE TABLE IF NOT EXISTS preferencias_usuario (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL UNIQUE REFERENCES usuarios(id) ON DELETE CASCADE,
        equipo_favorito_nombre VARCHAR(100), -- Nombre del equipo/país (ej: Real Madrid, Argentina)
        equipo_favorito_logo VARCHAR(255)
      );

      -- 6. Camisetas Guardadas (Wishlist, usa ID externo de producto)
      CREATE TABLE IF NOT EXISTS camisetas_guardadas (
        id SERIAL PRIMARY KEY,
        usuario_id INT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        producto_id VARCHAR(50) NOT NULL, -- ID de la API Externa
        UNIQUE(usuario_id, producto_id)
      );
    `;
    
    await client.query(createTablesQuery);
    console.log('¡Estructura de BD verificada y lista para APIs externas!');
    
    await seedDatabase(client);

  } catch (err) {
    console.error('Error al inicializar la base de datos:', err.stack);
  } finally {
    client.release();
  }
}

// --- Cargar datos de ejemplo (Equipos Favoritos para la simulación) ---
async function seedDatabase(client) {
  try {
    const resEquipos = await client.query('SELECT COUNT(*) FROM equipos');
    if (resEquipos.rows[0].count > 0) return;

    console.log('Cargando equipos base para selección de favorito...');
    
    await client.query(`
      INSERT INTO equipos (nombre, logo_url) VALUES
      ('Real Madrid', 'https://upload.wikimedia.org/wikipedia/en/thumb/5/56/Real_Madrid_CF.svg/1200px-Real_Madrid_CF.svg.png'),
      ('FC Barcelona', 'https://upload.wikimedia.org/wikipedia/en/thumb/4/47/FC_Barcelona_%28crest%29.svg/1200px-FC_Barcelona_%28crest%29.svg.png'),
      ('Boca Juniors', 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Escudo_Boca_Juniors.png/800px-Escudo_Boca_Juniors.png');
    `);
  } catch (error) {
    console.error('Error al cargar datos de ejemplo:', error);
  }
}

// --- Middlewares y Auth ---
app.use(cors());
app.use(express.json());

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
    // ... (Tu lógica de registro con bcrypt)
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
    if (error.code === '23505') return res.status(409).json({ message: "El correo electrónico ya está registrado." });
    res.status(500).json({ message: "Error interno del servidor" });
  }
});

app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const userResult = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    if (userResult.rows.length === 0) return res.status(401).json({ message: "Credenciales incorrectas." });
    const usuario = userResult.rows[0];
    const isMatch = await bcrypt.compare(password, usuario.password);
    if (!isMatch) return res.status(401).json({ message: "Credenciales incorrectas." });
    const token = jwt.sign({ userId: usuario.id, email: usuario.email }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({
      message: "Inicio de sesión exitoso",
      token,
      usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email }
    });
  } catch (error) {
    res.status(500).json({ message: "Error interno del servidor" });
  }
});


// --- Rutas de Tienda (Proxy a Fake Store - Camisetas) ---
const FAKE_STORE_API_URL = 'https://fakestoreapi.com/products';

app.get('/api/productos', authenticateToken, async (req, res) => {
  try {
    const response = await axios.get(FAKE_STORE_API_URL);
    // Mapeamos los productos para simular que son camisetas de fútbol.
    const camisetas = response.data.map(p => ({
      id: p.id.toString(), 
      nombre: `Jersey Oficial ${p.category} ${p.title.split(' ').slice(0, 2).join(' ')}`,
      descripcion: p.description,
      precio: p.price,
      imagen_url: p.image,
    })).filter(p => p.id < 15); // Limitar a 15 productos

    res.json(camisetas);
  } catch (error) {
    res.status(500).json({ message: 'Error al cargar productos de la tienda.' });
  }
});

// Proxy para añadir al carrito (guarda el ID externo)
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

// Rutas de Carrito (usa IDs externos)
app.get('/api/carrito', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT * FROM carrito WHERE usuario_id = $1', [req.user.userId]);
  res.json(result.rows);
});

// Rutas de Preferencias (Guardar/Obtener equipo favorito)
app.get('/api/preferencias', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT * FROM preferencias_usuario WHERE usuario_id = $1', [req.user.userId]);
  res.json(result.rows.length > 0 ? result.rows[0] : null);
});

app.post('/api/preferencias', authenticateToken, async (req, res) => {
  const { nombre, logo } = req.body;
  if (!nombre || !logo) return res.status(400).json({ message: 'Nombre y logo del equipo son requeridos.' });
  try {
    const result = await pool.query(
      `INSERT INTO preferencias_usuario (usuario_id, equipo_favorito_nombre, equipo_favorito_logo)
       VALUES ($1, $2, $3)
       ON CONFLICT (usuario_id) DO UPDATE SET
         equipo_favorito_nombre = $2,
         equipo_favorito_logo = $3
       RETURNING *`,
      [req.user.userId, nombre, logo]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al guardar preferencia', error: error.message });
  }
});


// --- ¡RUTA ESTABLE! EQUIPOS DEL MUNDO (Para la selección de favorito) ---
app.get('/api/equipos-del-mundo', authenticateToken, async (req, res) => {
  try {
    // 1. Obtener la lista de países (simulando ligas internacionales)
    const response = await axios.get('https://restcountries.com/v3.1/region/europe');
    
    const equiposMundiales = response.data.map(country => ({
      id: country.cca3, 
      nombre: country.translations.spa.common,
      logo: country.flags.png,
    })).filter((_, index) => index < 10); 

    // 2. Obtener equipos locales (Real Madrid, Barcelona, Boca)
    const equiposLocales = await pool.query('SELECT nombre, logo_url FROM equipos');
    
    const equiposFinal = [
      ...equiposLocales.rows.map((e, index) => ({ id: e.nombre, nombre: e.nombre, logo: e.logo_url })),
      ...equiposMundiales
    ];

    res.json(equiposFinal);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener equipos para preferencias.' });
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