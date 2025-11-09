// Cargar variables de entorno (del archivo .env)
require('dotenv').config();

// --- Importar Librerías ---
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library'); // Para Google
const jwt = require('jsonwebtoken'); // Para nuestros tokens

// --- Configuración ---
const app = express();
const PORT = process.env.PORT || 3001;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
// Cliente de Google Auth con el ID de tu .env
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// --- Inicialización de la BD (Sin cambios) ---
async function initializeDatabase() {
  console.log('Verificando la estructura de la base de datos (PostgreSQL)...');
  const client = await pool.connect();
  try {
    const createTablesQuery = `
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        password VARCHAR(255), -- Hacemos la contraseña opcional para Login de Google
        whatsapp_number VARCHAR(25) UNIQUE,
        google_id VARCHAR(255) UNIQUE, -- Para guardar el ID único de Google
        created_at TIMESTPNTZ DEFAULT NOW()
      );
    `;
    await client.query(createTablesQuery);
    console.log('¡Tablas (actualizadas) verificadas/creadas con éxito!');
  } catch (err) {
    console.error('Error al inicializar la base de datos:', err.stack);
  } finally {
    client.release();
  }
}

// --- Middlewares ---
app.use(cors());
app.use(express.json());

// --- Rutas (Endpoints) ---

app.get('/', (req, res) => {
  res.send('¡El backend de FutbolApp está funcionando!');
});

// ¡NUEVA RUTA DE AUTENTICACIÓN!
app.post('/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body; // Recibimos el token de la app móvil

    // 1. Verificar el token de Google
    const ticket = await googleClient.verifyIdToken({
        idToken: idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const { sub: google_id, email, name } = payload;

    // 2. Buscar usuario en nuestra BD
    let userResult = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    let usuario;

    if (userResult.rows.length > 0) {
      // 3A. Si el usuario existe, lo usamos
      usuario = userResult.rows[0];
      // Opcional: actualizar su google_id si no lo tenía
      if (!usuario.google_id) {
        await pool.query('UPDATE usuarios SET google_id = $1 WHERE email = $2', [google_id, email]);
      }
    } else {
      // 3B. Si no existe, lo creamos
      // Nota: La contraseña es 'null' porque se logueó con Google
      const newUserResult = await pool.query(
        'INSERT INTO usuarios (nombre, email, google_id) VALUES ($1, $2, $3) RETURNING *',
        [name, email, google_id]
      );
      usuario = newUserResult.rows[0];
    }

    // 4. Crear nuestro propio token (JWT)
    const token = jwt.sign(
      { userId: usuario.id, email: usuario.email }, // Datos que guardamos en el token
      process.env.JWT_SECRET, // El secreto del .env
      { expiresIn: '7d' } // El token expira en 7 días
    );

    // 5. Enviar el token y los datos del usuario a la app
    res.status(200).json({
      message: "Autenticación exitosa",
      token: token,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre,
        email: usuario.email,
      }
    });

  } catch (error) {
    console.error('Error en /auth/google:', error);
    res.status(401).json({ message: "Autenticación fallida", error: error.message });
  }
});

// --- Iniciar el Servidor ---
async function startServer() {
  try {
    await initializeDatabase(); // Asegura que las tablas (actualizadas) existan
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('Fallo al iniciar el servidor:', error);
  }
}

startServer();