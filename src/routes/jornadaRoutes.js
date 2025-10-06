const express = require('express');
const router = express.Router();
const jornadaController = require('../controllers/jornadaController');

// Ruta optimizada para obtener jornadas paginadas
router.get('/paginadas', jornadaController.obtenerJornadasPaginadas);

// Ruta para obtener todas las jornadas (legacy)
router.get('/', jornadaController.obtenerJornadas);

router.get('/operario/:operarioId/fecha/:fecha', jornadaController.obtenerJornadasPorOperarioYFecha); // Ruta para obtener jornada por operario y fecha

// 📌 registro de produccion en jornada
router.post('/', jornadaController.crearJornada); // Para crear la jornada inicial
router.post('/:jornadaId/actividades', jornadaController.agregarActividadAJornada); // Para agregar una actividad a una jornada existente
router.get('/operario/:id', jornadaController.obtenerJornadasPorOperario);
router.post('/completa', jornadaController.guardarJornadaCompleta); 
router.get('/:id', jornadaController.obtenerJornada);
router.put('/:id', jornadaController.actualizarJornada);
router.delete('/:id', jornadaController.eliminarJornada);

// Ruta para recalcular tiempos efectivos (Admin only)
router.post('/recalcular-tiempos', jornadaController.recalcularTiemposEfectivos);

// Ruta para obtener reporte de jornadas y permisos laborales
router.get('/reporte-permisos', jornadaController.obtenerReporteJornadasPermisos);

module.exports = router;