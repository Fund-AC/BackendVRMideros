// backend/controllers/jornadaController.js

const mongoose = require('mongoose');
const Produccion = require('../models/Produccion');
const Jornada = require('../models/Jornada');
const Operario = require('../models/Operario');
const { recalcularTiempoTotal } = require('../utils/recalcularTiempo');
const { recalcularHorasJornada } = require('../utils/recalcularHoras');
const { recalcularTiemposJornadas } = require('../utils/recalcularTiemposEfectivos');
const { normalizarFecha } = require('../utils/manejoFechas');

/**
 * Consolida jornadas duplicadas del mismo día para un operario
 */
async function consolidarJornadasDuplicadas(operarioId, jornadas) {
    if (!jornadas || jornadas.length <= 1) return jornadas;

    // Agrupar jornadas por fecha normalizada
    const jornadasPorFecha = {};

    for (const jornada of jornadas) {
        const fechaNormalizada = normalizarFecha(jornada.fecha);
        const claveDate = fechaNormalizada.toDateString();

        if (!jornadasPorFecha[claveDate]) {
            jornadasPorFecha[claveDate] = [];
        }
        jornadasPorFecha[claveDate].push(jornada);
    }

    const jornadasConsolidadas = [];

    // Procesar cada grupo de jornadas del mismo día
    for (const [fechaStr, jornadasDelDia] of Object.entries(jornadasPorFecha)) {
        if (jornadasDelDia.length > 1) {
            // REMOVED: console.log(`🔧 Consolidando ${jornadasDelDia.length} jornadas duplicadas del ${new Date(fechaStr).toLocaleDateString('es-ES')}`);

            // Combinar todos los registros únicos
            const registrosCombinados = new Set();
            const fechaNormalizada = normalizarFecha(jornadasDelDia[0].fecha);

            for (const jornada of jornadasDelDia) {
                if (jornada.registros) {
                    jornada.registros.forEach(registro => {
                        if (typeof registro === 'object' && registro._id) {
                            registrosCombinados.add(registro._id.toString());
                        } else {
                            registrosCombinados.add(registro.toString());
                        }
                    });
                }
            }

            // Eliminar todas las jornadas duplicadas de la base de datos
            for (const jornada of jornadasDelDia) {
                await Jornada.findByIdAndDelete(jornada._id);
            }

            // Crear una nueva jornada consolidada
            const nuevaJornada = new Jornada({
                operario: operarioId,
                fecha: fechaNormalizada,
                registros: Array.from(registrosCombinados),
                totalTiempoActividades: { horas: 0, minutos: 0 }
            });

            await nuevaJornada.save();

            // Hacer populate para devolver al frontend
            const jornadaPopulada = await Jornada.findById(nuevaJornada._id).populate({
                path: 'registros',
                populate: [
                    { path: 'procesos', model: 'Proceso', select: 'nombre' },
                    { path: 'oti', select: 'numeroOti' },
                    { path: 'areaProduccion', select: 'nombre' },
                    { path: 'maquina', model: 'Maquina', select: 'nombre' },
                    { path: 'insumos', model: 'Insumo', select: 'nombre' }
                ]
            });

            jornadasConsolidadas.push(jornadaPopulada);
            // REMOVED: console.log(`✅ Jornada consolidada con ${registrosCombinados.size} actividades`);
        } else {
            // Si solo hay una jornada, normalizarla y agregarla
            const jornada = jornadasDelDia[0];
            const fechaNormalizada = normalizarFecha(jornada.fecha);

            if (jornada.fecha.getTime() !== fechaNormalizada.getTime()) {
                // REMOVED: console.log(`🔧 Normalizando fecha de jornada: ${jornada.fecha} -> ${fechaNormalizada}`);
                jornada.fecha = fechaNormalizada;
                await jornada.save();
            }

            jornadasConsolidadas.push(jornada);
        }
    }

    return jornadasConsolidadas.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
}

exports.crearJornada = async (req, res) => {
    try {
        const { operario, fecha } = req.body;

        if (!mongoose.Types.ObjectId.isValid(operario)) {
            return res.status(400).json({ error: 'ID de operario inválido' });
        }

        const fechaNormalizada = new Date(fecha);
        fechaNormalizada.setUTCHours(0, 0, 0, 0);

        const jornadaExistente = await Jornada.findOne({ operario: operario, fecha: fechaNormalizada });

        if (jornadaExistente) {
            return res.status(400).json({ error: 'Ya existe una jornada para este operario en la fecha actual', jornadaId: jornadaExistente._id });
        }

        const nuevaJornada = new Jornada({
            operario,
            fecha: new Date(fecha + 'T00:00:00.000Z'),
            registros: [],
            totalTiempoActividades: { horas: 0, minutos: 0 }
        });

        await nuevaJornada.save();

        res.status(201).json({ msg: 'Jornada creada con éxito', jornadaId: nuevaJornada._id, jornada: nuevaJornada });

    } catch (error) {
        console.error('Error al crear la jornada:', error);
        res.status(500).json({ error: 'Hubo un error al crear la jornada' });
    }
};

// @desc    Obtener todas las Jornadas
// @route   GET /api/jornadas
exports.obtenerJornadas = async (req, res) => {
    try {
        const { limit, sort } = req.query;
        let query = Jornada.find();

        if (sort) {
            const sortParams = {};
            const parts = sort.split(':');
            sortParams[parts[0]] = parts[1] === 'desc' ? -1 : 1;
            query = query.sort(sortParams);
        } else {
            // Default sort if not provided
            query = query.sort({ fecha: -1 });
        }

        if (limit) {
            query = query.limit(parseInt(limit, 10));
        }

        // Popular el campo operario de la Jornada
        query = query.populate('operario', 'name');

        const jornadas = await query
            .populate('operario', 'name')
            .populate({
                path: 'registros',
                populate: [
                    { path: 'operario', select: 'name' },
                    { path: 'oti', select: '_id numeroOti' },
                    { path: 'procesos', model: 'Proceso', select: 'nombre' },
                    { path: 'areaProduccion', select: 'nombre' },
                    { path: 'maquina', model: 'Maquina', select: 'nombre' },
                    { path: 'insumos', model: 'Insumo', select: 'nombre' }
                ],
            });

        const jornadasConTiempo = jornadas.map(jornada => {
            // Calcular tiempo efectivo a pagar (descontando permisos no remunerados)
            let tiempoEfectivoAPagar = { horas: 0, minutos: 0 };     
            
            // Método 1: Usar horaInicio y horaFin de la jornada si existen
            if (jornada.horaInicio && jornada.horaFin) {
                const inicio = new Date(jornada.horaInicio);
                let fin = new Date(jornada.horaFin);
                
                if (fin <= inicio) {
                    fin = new Date(fin.getTime() + 24 * 60 * 60 * 1000);
                }
                
                let tiempoTotalJornadaMinutos = Math.round((fin - inicio) / (1000 * 60));
                
                // Calcular minutos de permisos no remunerados
                const minutosPermisosNoRemunerados = jornada.registros
                    .filter(registro => registro.tipoPermiso === 'permiso NO remunerado')
                    .reduce((total, registro) => total + (registro.tiempo || 0), 0);
                
                // Tiempo efectivo = Tiempo total - Permisos no remunerados
                const tiempoEfectivoMinutos = tiempoTotalJornadaMinutos - minutosPermisosNoRemunerados;
                
                if (tiempoEfectivoMinutos > 0) {
                    tiempoEfectivoAPagar = {
                        horas: Math.floor(tiempoEfectivoMinutos / 60),
                        minutos: tiempoEfectivoMinutos % 60
                    };
                }
            }
            // Método 2: Si no hay horas de jornada, usar la suma de actividades menos permisos no remunerados
            else if (jornada.registros && jornada.registros.length > 0) {
                // Calcular tiempo total de todas las actividades
                const tiempoTotalActividades = jornada.registros.reduce((total, registro) => {
                    return total + (registro.tiempo || 0);
                }, 0);
                
                // Calcular minutos de permisos no remunerados
                const minutosPermisosNoRemunerados = jornada.registros
                    .filter(registro => registro.tipoPermiso === 'permiso NO remunerado')
                    .reduce((total, registro) => total + (registro.tiempo || 0), 0);
                
                // Tiempo efectivo = Total actividades - Permisos no remunerados
                const tiempoEfectivoMinutos = tiempoTotalActividades - minutosPermisosNoRemunerados;
                
                if (tiempoEfectivoMinutos > 0) {
                    tiempoEfectivoAPagar = {
                        horas: Math.floor(tiempoEfectivoMinutos / 60),
                        minutos: tiempoEfectivoMinutos % 60
                    };
                }
            }
            // Método 3: Como fallback, usar totalTiempoActividades si existe
            else if (jornada.totalTiempoActividades && 
                     (jornada.totalTiempoActividades.horas > 0 || jornada.totalTiempoActividades.minutos > 0)) {
                tiempoEfectivoAPagar = {
                    horas: jornada.totalTiempoActividades.horas || 0,
                    minutos: jornada.totalTiempoActividades.minutos || 0
                };
            }            
                   
            return {
                ...jornada.toObject(),
                totalTiempoActividades: jornada.totalTiempoActividades || { horas: 0, minutos: 0 },
                tiempoEfectivoAPagar // ✅ Campo calculado con múltiples métodos
            };
        });

        res.status(200).json(jornadasConTiempo);
    } catch (error) {
        console.error('Error fetching Jornadas:', error);
        res.status(500).json({ error: 'Error al obtener jornadas' });
    }
};

// @desc    Obtener una jornada por ID
// @route   GET /api/jornadas/:id
exports.obtenerJornada = async (req, res) => {
    try {
        const { id } = req.params;

        // Validar el ID
        if (!mongoose.Types.ObjectId.isValid(id)) {
            console.error(`ID de Jornada inválido: ${id}`);
            return res.status(400).json({ error: 'ID de jornada inválido' });
        }
        // Asegurarse de que todos los campos relacionados se populen correctamente
        const jornada = await Jornada.findById(id)
            .populate('operario', 'name') // <--- Añadir esta línea para popular el operario
            .populate({
                path: 'registros',
                populate: [
                    { path: 'oti', model: 'Oti', select: '_id numeroOti' },
                    { path: 'procesos', model: 'Proceso', select: 'nombre' },
                    { path: 'areaProduccion', model: 'AreaProduccion', select: 'nombre' },
                    { path: 'maquina', model: 'Maquina', select: 'nombre' },
                    { path: 'insumos', model: 'Insumo', select: 'nombre' }
                ]
            });

        if (!jornada) {
            console.error(`Jornada no encontrada para ID: ${id}`);
            return res.status(404).json({ error: 'Jornada no encontrada' });
        }

        res.status(200).json(jornada);

    } catch (error) {
        console.error(`Error al obtener la Jornada con ID ${req.params.id}:`, error);
        res.status(500).json({ error: 'Error al obtener la Jornada' });
    }
};

// @desc    Obtener jornadas por operario
// @route   GET /api/jornadas/operario/:id
exports.obtenerJornadasPorOperario = async (req, res) => {
    const { id } = req.params; // Operario ID
    const { fecha } = req.query; // Optional date filter

    try {
        // REMOVED: console.log(`🔎 Buscando jornadas para el operario con ID: ${id}${fecha ? ` con filtro de fecha: ${fecha}` : ''}`);

        // Verificar si el operario existe
        const operarioExiste = await Operario.findById(id);
        if (!operarioExiste) {
            console.error(`❌ Operario con ID ${id} no encontrado`);
            return res.status(404).json({ msg: 'Operario no encontrado' });
        }
        // REMOVED: console.log(`✅ Operario encontrado:`, operarioExiste.name);

        // Construir el filtro de búsqueda
        let filtro = { operario: id };        // Si se proporciona una fecha, agregar filtro de fecha usando normalización correcta
        if (fecha) {
            const { obtenerRangoDia } = require('../utils/manejoFechas');
            const rango = obtenerRangoDia(fecha);
            filtro.fecha = {
                $gte: rango.inicio,
                $lte: rango.fin
            };
        }// Obtener las jornadas con el filtro aplicado
        const jornadas = await Jornada.find(filtro).sort({ fecha: -1 });

        // Si no hay jornadas, devolver un array vacío inmediatamente
        if (!jornadas || jornadas.length === 0) {
            return res.json([]);
        }

        // NUEVA LÓGICA: Consolidar jornadas duplicadas antes de procesarlas
        // REMOVED: console.log(`🔍 Encontradas ${jornadas.length} jornadas antes de consolidación`);
        const jornadasConsolidadas = await consolidarJornadasDuplicadas(id, jornadas);
        // REMOVED: console.log(`✅ ${jornadasConsolidadas.length} jornadas después de consolidación`);

        // Hacer populate completo para cada jornada consolidada
        const jornadasConTiempo = await Promise.all(jornadasConsolidadas.map(async (jornada) => {
            // Si ya está populada (viene de consolidación), devolverla directamente
            if (jornada.registros && jornada.registros.length > 0 &&
                typeof jornada.registros[0] === 'object' && jornada.registros[0].oti) {
                return jornada;
            }

            // Si no está populada, hacer populate
            const populatedJornada = await Jornada.findById(jornada._id).populate({
                path: 'registros',
                populate: [
                    { path: 'procesos', model: 'Proceso', select: 'nombre' },
                    { path: 'oti', select: 'numeroOti' },
                    { path: 'areaProduccion', select: 'nombre' },
                    { path: 'maquina', model: 'Maquina', select: 'nombre' },
                    { path: 'insumos', model: 'Insumo', select: 'nombre' }
                ]
            });
            return populatedJornada;
        }));


        // REMOVED: console.log(`✅ Jornadas encontradas para ${operarioExiste.name}: ${jornadasConTiempo.length}`); // Usar jornadasConTiempo
        res.json(jornadasConTiempo); // Asegúrate de enviar jornadasConTiempo, no 'jornadas'

    } catch (error) {
        console.error(`🚨 Error al obtener las jornadas del operario ${id}:`, error);
        res.status(500).json({ msg: 'Error al obtener las jornadas' });
    }
};


// @desc    Obtener jornadas por operario y fecha
// @route   GET /api/jornadas/operario/:operarioId/fecha/:fecha
exports.obtenerJornadasPorOperarioYFecha = async (req, res) => {
    try {
        const { operarioId, fecha } = req.params;
        // REMOVED: console.log(`🔎 Buscando jornadas para el operario con ID: ${operarioId} y fecha: ${fecha}`);

        // Opcional: Verificar si el operario existe (solo para logs, no es estrictamente necesario para la query)
        const operario = await Operario.findById(operarioId);
        if (operario) {
            // REMOVED: console.log(`✅ Operario encontrado: ${operario.name}`);
        } else {
            // REMOVED: console.log(`⚠️ Operario no encontrado con ID: ${operarioId}`);
        } const { obtenerRangoDia } = require('../utils/manejoFechas');
        const rango = obtenerRangoDia(fecha);

        const jornadas = await Jornada.find({
            operario: operarioId,
            fecha: {
                $gte: rango.inicio,
                $lte: rango.fin
            }
        });

        // REMOVED: console.log(`🔍 Encontradas ${jornadas.length} jornadas para ${operario ? operario.name : 'ID ' + operarioId} en ${fecha}`);

        if (jornadas.length === 0) {
            return res.status(404).json({ message: "No se encontraron jornadas para este operario en esta fecha." });
        }

        // NUEVA LÓGICA: Consolidar jornadas duplicadas antes de devolverlas
        const jornadasConsolidadas = await consolidarJornadasDuplicadas(operarioId, jornadas);
        // REMOVED: console.log(`✅ ${jornadasConsolidadas.length} jornadas después de consolidación`);

        res.status(200).json(jornadasConsolidadas);
    } catch (error) {
        console.error("Error al buscar jornada por operario y fecha:", error);
        if (error.name === 'CastError') {
            return res.status(400).json({ message: "ID de operario o formato de fecha inválido." });
        }
        res.status(500).json({ message: "Error interno del servidor." });
    }
};

// @desc    Actualizar una jornada (general, incluyendo horas de inicio/fin y registros)
// @route   PUT /api/jornadas/:id
exports.actualizarJornada = async (req, res) => {
    try {
        const { id } = req.params;
        const { horaInicio, horaFin, registros, estado } = req.body;

        // Validar ID de la jornada
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ error: 'ID de jornada inválido' });
        }

        const updateFields = {};
        if (horaInicio !== undefined) updateFields.horaInicio = horaInicio;
        if (horaFin !== undefined) updateFields.horaFin = horaFin;
        if (registros !== undefined) updateFields.registros = registros;
        if (estado !== undefined) updateFields.estado = estado;

        const jornada = await Jornada.findByIdAndUpdate(
            id,
            updateFields,
            { new: true }
        );

        if (!jornada) {
            return res.status(404).json({ error: 'Jornada no encontrada' });
        }

        // Recalcular las horas y el tiempo total de la jornada después de la actualización
        await recalcularHorasJornada(id);
        // Recalcular el tiempo total de actividades
        await recalcularTiempoTotal(id);

        res.status(200).json(await Jornada.findById(id).populate('registros'));

    } catch (error) {
        console.error('Error al actualizar Jornada:', error);
        if (error.name === 'ValidationError') {
            return res.status(400).json({ msg: error.message, errors: error.errors });
        }
        res.status(500).json({ error: 'Error al actualizar Jornada' });
    }
};

// @desc    Eliminar una jornada
// @route   DELETE /api/jornadas/:id
exports.eliminarJornada = async (req, res) => {
    try {
        const { id } = req.params;

        const jornada = await Jornada.findByIdAndDelete(id);
        if (!jornada) {
            return res.status(404).json({ error: 'Jornada no encontrada' });
        }
        res.status(200).json({ message: 'Jornada eliminada exitosamente' });
    } catch (error) {
        console.error('Error al eliminar Jornada:', error);
        res.status(500).json({ error: 'Error al eliminar Jornada' });
    }
};

exports.agregarActividadAJornada = async (req, res) => {
    try {
        const { jornadaId } = req.params;
        const {
            operario,
            fecha, // Asegúrate de que esta 'fecha' es la fecha de la actividad, no la de la jornada
            oti,
            proceso,
            areaProduccion,
            maquina,
            insumos,
            tipoTiempo,
            horaInicio,
            horaFin,
            tiempo,
            observaciones
        } = req.body;

        // Validar que el ID de la jornada sea válido
        if (!mongoose.Types.ObjectId.isValid(jornadaId)) {
            return res.status(400).json({ error: 'ID de jornada inválido' });
        }

        // Buscar la jornada
        const jornada = await Jornada.findById(jornadaId);
        if (!jornada) {
            return res.status(404).json({ error: 'Jornada no encontrada' });
        }

        // Normalizar la fecha de la actividad si es diferente a la de la jornada
        const fechaActividadNormalizada = new Date(fecha);
        fechaActividadNormalizada.setUTCHours(0, 0, 0, 0);


        // Validar los campos de la actividad
        const camposRequeridos = { operario, oti, proceso, areaProduccion, maquina, insumos, tipoTiempo, horaInicio, horaFin };
        for (const [clave, valor] of Object.entries(camposRequeridos)) {
            if (!valor) return res.status(400).json({ error: `Falta el campo: ${clave}` });
        }
        if (proceso && !mongoose.Types.ObjectId.isValid(proceso)) return res.status(400).json({ error: 'Proceso ID is invalid' });
        if (areaProduccion && !mongoose.Types.ObjectId.isValid(areaProduccion)) return res.status(400).json({ error: 'Area ID is invalid' });
        if (maquina && !mongoose.Types.ObjectId.isValid(maquina)) return res.status(400).json({ error: 'Maquina ID is invalid' });
        if (insumos && !mongoose.Types.ObjectId.isValid(insumos)) return res.status(400).json({ error: 'Insumos ID is invalid' });


        // Crear un nuevo registro de producción (actividad individual)
        const nuevoRegistro = new Produccion({
            operario,
            fecha: fechaActividadNormalizada, // Usar la fecha de la actividad o la de la jornada si son iguales
            oti,
            proceso,
            areaProduccion,
            maquina,
            insumos,
            tipoTiempo,
            horaInicio,
            horaFin,
            tiempo: tiempo || 0,
            observaciones: observaciones || null,
            jornada: jornadaId
        });
        await nuevoRegistro.save();

        // Agregar el _id del nuevo registro a la jornada
        jornada.registros.push(nuevoRegistro._id);
        await jornada.save();



        res.status(200).json({ msg: 'Actividad agregada con éxito', jornada: await Jornada.findById(jornadaId).populate('registros') });

    } catch (error) {
        console.error('Error al agregar actividad a la jornada:', error);
        if (error.name === 'ValidationError') {
            return res.status(400).json({ msg: error.message, errors: error.errors });
        }
        res.status(500).json({ error: 'Hubo un error al agregar la actividad a la jornada' });
    }
};

// @desc    Guardar Jornada Completa (maneja creación y adición de actividades en un solo POST)
// @route   POST /api/jornadas/completa (RUTA QUE USAS PARA "GUARDAR JORNADA COMPLETA")
exports.guardarJornadaCompleta = async (req, res) => {
    try {
        const { operario, fecha, horaInicio, horaFin, actividades } = req.body;

        // Validar ObjectId para operario
        if (!mongoose.Types.ObjectId.isValid(operario)) {
            console.error('❌ ID de operario inválido:', operario);
            return res.status(400).json({ error: 'ID de operario inválido' });
        }

        // Validar que hay actividades
        if (!Array.isArray(actividades) || actividades.length === 0) {
            console.error('❌ No se proporcionaron actividades o el array está vacío');
            return res.status(400).json({ error: 'Debe proporcionar al menos una actividad' });
        }

        // REMOVED: console.log(`📊 Procesando ${actividades.length} actividad(es)`);        // Normalizar la fecha de la jornada usando la función correcta
        const { normalizarFecha } = require('../utils/manejoFechas');
        const fechaNormalizada = normalizarFecha(fecha);

        let jornada = await Jornada.findOne({ operario: operario, fecha: fechaNormalizada });

        if (!jornada) {
            // REMOVED: console.log('🆕 Creando nueva jornada');
            // Crear nueva jornada si no existe
            jornada = new Jornada({
                operario,
                fecha: fechaNormalizada,
                horaInicio: horaInicio, // Se espera que sea una fecha ISO completa o null
                horaFin: horaFin,       // Se espera que sea una fecha ISO completa o null
                registros: [],
                // totalTiempoActividades se calculará con el hook pre-save o recalcularHorasJornada
            });
        } else {
            // REMOVED: console.log('🔄 Actualizando jornada existente');
            // Actualizar horas de jornada existente si se proporcionan y son diferentes
            if (horaInicio && jornada.horaInicio !== horaInicio) {
                jornada.horaInicio = horaInicio;
            }
            if (horaFin && jornada.horaFin !== horaFin) {
                jornada.horaFin = horaFin;
            }
        }

        // Procesar y agregar actividades
        const idsNuevosRegistros = [];
        if (Array.isArray(actividades) && actividades.length > 0) {
            for (const actividad of actividades) {                // Validaciones básicas de campos requeridos para la actividad
                if (!actividad.oti || !actividad.areaProduccion || !actividad.maquina || !actividad.tipoTiempo || !actividad.horaInicio || !actividad.horaFin) {
                    return res.status(400).json({ error: `Faltan campos requeridos en una actividad: ${JSON.stringify(actividad)}` });
                }

                // Función para verificar y crear OTI si es necesario
                const verificarYCrearOti = async (numeroOti) => {
                    const Oti = require('../models/Oti');
                    try {
                        // Si ya es un ObjectId válido, retornarlo
                        if (mongoose.Types.ObjectId.isValid(numeroOti) && numeroOti.length === 24) {
                            return numeroOti;
                        }

                        // Si es un string, buscar o crear el OTI
                        let oti = await Oti.findOne({ numeroOti: numeroOti });
                        if (!oti) {
                            oti = new Oti({ numeroOti });
                            await oti.save();
                        }
                        return oti._id;
                    } catch (error) {
                        console.error('Error al verificar/crear OTI:', error);
                        throw new Error(`Error al procesar OTI: ${numeroOti}`);
                    }
                };

                // Validar y obtener ObjectId para OTI
                let otiId;
                try {
                    otiId = await verificarYCrearOti(actividad.oti);
                } catch (error) {
                    return res.status(400).json({ error: error.message });
                }

                // Validar IDs de ObjectId para area
                if (!mongoose.Types.ObjectId.isValid(actividad.areaProduccion)) return res.status(400).json({ error: 'ID de Área de Producción inválido en actividad' });

                // Validar 'maquina': debe ser un array de ObjectIds válidos y no vacío
                if (!Array.isArray(actividad.maquina) || actividad.maquina.length === 0) {
                    return res.status(400).json({ error: "El campo 'maquina' es requerido y debe ser un array no vacío de IDs en actividad." });
                }
                for (const maquinaId of actividad.maquina) {
                    if (!mongoose.Types.ObjectId.isValid(maquinaId)) {
                        return res.status(400).json({ error: `ID de maquina inválido (${maquinaId}) en actividad` });
                    }
                }

                // Validar 'procesos': debe ser un array de ObjectIds válidos y no vacío
                if (!Array.isArray(actividad.procesos) || actividad.procesos.length === 0) {
                    return res.status(400).json({ error: "El campo 'procesos' es requerido y debe ser un array no vacío de IDs en actividad." });
                }
                for (const procesoId of actividad.procesos) {
                    if (!mongoose.Types.ObjectId.isValid(procesoId)) {
                        return res.status(400).json({ error: `ID de Proceso inválido (${procesoId}) en actividad` });
                    }
                }

                if (!Array.isArray(actividad.insumos) || actividad.insumos.length === 0) {
                    return res.status(400).json({ error: "El campo 'insumos' es requerido y debe ser un array no vacío de IDs en actividad." });
                }
                for (const insumoId of actividad.insumos) {
                    if (!mongoose.Types.ObjectId.isValid(insumoId)) {
                        return res.status(400).json({ error: `ID de Insumo inválido (${insumoId}) en actividad` });
                    }
                }

                // Calcular tiempo en minutos si no se proporciona o es 0
                let tiempoCalculado = actividad.tiempo || 0;
                if (!tiempoCalculado || tiempoCalculado === 0) {
                    const inicio = new Date(actividad.horaInicio);
                    let fin = new Date(actividad.horaFin);

                    // Manejar cruce de medianoche: si fin <= inicio, asumir que fin es del día siguiente
                    if (fin <= inicio) {
                        // Agregar 24 horas (86400000 ms) a la hora de fin
                        fin = new Date(fin.getTime() + 24 * 60 * 60 * 1000);
                    }

                    if (inicio && fin && fin > inicio) {
                        tiempoCalculado = Math.round((fin - inicio) / (1000 * 60)); // Diferencia en minutos
                    } else {
                        tiempoCalculado = 1; // Valor mínimo para evitar error de validación
                    }
                }

                // Crear y guardar cada registro de producción
                const nuevoRegistro = new Produccion({
                    operario: jornada.operario, // Usar el operario de la jornada
                    fecha: jornada.fecha,       // Usar la fecha de la jornada
                    oti: otiId, // Usar el ObjectId verificado/creado
                    procesos: actividad.procesos, // Array de ObjectIds
                    areaProduccion: actividad.areaProduccion,
                    maquina: actividad.maquina || [],
                    insumos: actividad.insumos || [], // Array de ObjectIds
                    tipoTiempo: actividad.tipoTiempo,
                    tipoPermiso: actividad.tipoPermiso || null,
                    horaInicio: actividad.horaInicio, // Se espera que sea una fecha ISO completa
                    horaFin: actividad.horaFin,       // Se espera que sea una fecha ISO completa
                    tiempo: tiempoCalculado,    // Usar tiempo calculado
                    observaciones: actividad.observaciones || null,
                    jornada: jornada._id // Vincular a la jornada actual
                });
                await nuevoRegistro.save();
                idsNuevosRegistros.push(nuevoRegistro._id);
            }
        }

        // Añadir las IDs de los nuevos registros a la jornada, evitando duplicados si se reenvían actividades
        const registrosActualesComoStrings = jornada.registros.map(r => r.toString());
        const nuevosRegistrosComoStrings = idsNuevosRegistros.map(id => id.toString());

        const todosLosRegistrosUnicos = [...new Set([...registrosActualesComoStrings, ...nuevosRegistrosComoStrings])];
        jornada.registros = todosLosRegistrosUnicos.map(idStr => new mongoose.Types.ObjectId(idStr));        // REMOVED: console.log(`✅ Se crearon ${idsNuevosRegistros.length} nuevos registros`);
        // REMOVED: console.log('💾 Guardando jornada con registros actualizados');

        await jornada.save(); // Esto disparará los hooks pre-save de Jornada para recalcular tiempos y horas

        // No es necesario llamar a recalcularHorasJornada explícitamente si el hook pre-save lo hace.
        // await recalcularHorasJornada(jornada._id); // Comentado si el hook pre-save ya lo maneja

        // REMOVED: console.log('🔍 Populando jornada final para respuesta');
        const jornadaFinal = await Jornada.findById(jornada._id)
            .populate('operario', 'name cedula')
            .populate({
                path: 'registros',
                populate: [
                    { path: 'oti', select: 'numeroOti' },
                    { path: 'procesos', model: 'Proceso', select: 'nombre' }, // Asegurar model y select correctos
                    { path: 'areaProduccion', model: 'AreaProduccion', select: 'nombre' },
                    { path: 'maquina', model: 'Maquina', select: 'nombre' },
                    { path: 'insumos', model: 'Insumo', select: 'nombre' }
                ]
            });

        // REMOVED: console.log('🎉 Jornada guardada exitosamente');
        res.status(201).json({ msg: 'Jornada y actividades guardadas con éxito', jornada: jornadaFinal });

    } catch (error) {
        console.error('❌ Error al guardar la jornada completa:', error);
        
        // Manejo específico para errores de horario duplicado
        if (error.code === 'HORARIO_DUPLICADO') {
            console.error('❌ Error de horario laboral duplicado:', error.message);
            return res.status(400).json({ 
                msg: error.message,
                error: error.message,
                code: 'HORARIO_DUPLICADO'
            });
        }
        
        if (error.name === 'ValidationError') {
            console.error('❌ Error de validación:', error.errors);
            return res.status(400).json({ msg: error.message, errors: error.errors });
        }
        
        // Log del error completo para debugging
        console.error('❌ Error completo:', {
            name: error.name,
            message: error.message,
            code: error.code,
            stack: error.stack
        });
        
        res.status(500).json({ 
            error: 'Hubo un error al guardar la jornada completa',
            details: error.message 
        });
    }
};

// @desc    Recalcular tiempos efectivos en todas las jornadas
// @route   POST /api/jornadas/recalcular-tiempos
// @access  Admin only
exports.recalcularTiemposEfectivos = async (req, res) => {
    try {
        // REMOVED: console.log('🔄 Iniciando recálculo de tiempos efectivos...');

        const jornadas = await Jornada.find({}).populate('registros');

        if (jornadas.length === 0) {
            return res.status(404).json({
                message: 'No hay jornadas para procesar',
                estadisticas: {
                    totalJornadas: 0,
                    jornadasActualizadas: 0,
                    errores: 0
                }
            });
        }

        let jornadasActualizadas = 0;
        let errores = 0;
        let jornadasConSolapamientos = 0;
        let tiempoTotalRecuperado = 0;

        for (const jornada of jornadas) {
            try {
                const tiempoAnterior = jornada.totalTiempoActividades?.tiempoSumado || 0;

                // Guardar la jornada para activar el pre-save hook con nueva lógica
                await jornada.save();

                jornadasActualizadas++;

                // Verificar si hay solapamientos
                if (jornada.totalTiempoActividades?.solapamientos) {
                    jornadasConSolapamientos++;
                    const tiempoRecuperado = (jornada.totalTiempoActividades.tiempoSumado || 0) -
                        (jornada.totalTiempoActividades.tiempoEfectivo || 0);
                    tiempoTotalRecuperado += tiempoRecuperado;
                }

                // REMOVED: console.log(`✅ Jornada ${jornada._id} actualizada - Efectivo: ${jornada.totalTiempoActividades?.tiempoEfectivo || 0}min`);

            } catch (error) {
                console.error(`❌ Error procesando jornada ${jornada._id}:`, error.message);
                errores++;
            }
        }

        const estadisticas = {
            totalJornadas: jornadas.length,
            jornadasActualizadas,
            errores,
            jornadasConSolapamientos,
            tiempoTotalRecuperado,
            tiempoRecuperadoFormateado: {
                horas: Math.floor(tiempoTotalRecuperado / 60),
                minutos: tiempoTotalRecuperado % 60
            }
        };

        // REMOVED: console.log('📊 Recálculo completado:', estadisticas);

        res.status(200).json({
            message: 'Recálculo de tiempos efectivos completado',
            estadisticas
        });

    } catch (error) {
        console.error('❌ Error durante el recálculo de tiempos:', error);
        res.status(500).json({
            error: 'Error interno del servidor durante el recálculo',
            details: error.message
        });
    }
};

// @desc    Obtener reporte de jornadas y permisos laborales para Excel
// @route   GET /api/jornadas/reporte-permisos
// @access  Admin only
exports.obtenerReporteJornadasPermisos = async (req, res) => {
    try {
        const { fechaInicio, fechaFin, operarioId } = req.query;

        // Construir filtro base
        let filtro = {};
        
        // Filtro por operario si se especifica
        if (operarioId && mongoose.Types.ObjectId.isValid(operarioId)) {
            filtro.operario = operarioId;
        }
        
        // Filtro por rango de fechas si se especifica
        if (fechaInicio || fechaFin) {
            filtro.fecha = {};
            if (fechaInicio) {
                const fechaInicioDate = new Date(fechaInicio);
                fechaInicioDate.setHours(0, 0, 0, 0);
                filtro.fecha.$gte = fechaInicioDate;
            }
            if (fechaFin) {
                const fechaFinDate = new Date(fechaFin);
                fechaFinDate.setHours(23, 59, 59, 999);
                filtro.fecha.$lte = fechaFinDate;
            }
        }

        const jornadas = await Jornada.find(filtro)
            .populate('operario', 'name cedula')
            .populate({
                path: 'registros',
                populate: [
                    { path: 'operario', select: 'name' },
                    { path: 'oti', select: 'numeroOti' },
                    { path: 'procesos', model: 'Proceso', select: 'nombre' },
                    { path: 'areaProduccion', select: 'nombre' },
                    { path: 'maquina', model: 'Maquina', select: 'nombre' },
                    { path: 'insumos', model: 'Insumo', select: 'nombre' }
                ]
            })
            .sort({ fecha: -1 });

        // Filtrar solo jornadas que tienen actividades
        const jornadasConActividades = jornadas.filter(j => j.registros && j.registros.length > 0);

        // Procesar cada jornada para extraer información de permisos
        const reporteDetallado = jornadasConActividades.map(jornada => {
            const permisos = jornada.registros.filter(registro => 
                registro.tipoTiempo === 'Permiso Laboral'
            );

            // Calcular tiempo total de jornada en minutos
            let tiempoTotalJornadaMinutos = 0;
            if (jornada.horaInicio && jornada.horaFin) {
                const inicio = new Date(jornada.horaInicio);
                let fin = new Date(jornada.horaFin);
                
                if (fin <= inicio) {
                    fin = new Date(fin.getTime() + 24 * 60 * 60 * 1000);
                }
                
                tiempoTotalJornadaMinutos = Math.round((fin - inicio) / (1000 * 60));
            }

            return {
                _id: jornada._id,
                fecha: jornada.fecha,
                operario: jornada.operario,
                horaInicio: jornada.horaInicio,
                horaFin: jornada.horaFin,
                tiempoTotalJornadaMinutos,
                totalActividades: jornada.registros.length,
                permisos: permisos.map(permiso => ({
                    id: permiso._id,
                    horaInicio: permiso.horaInicio,
                    horaFin: permiso.horaFin,
                    tipoPermiso: permiso.tipoPermiso,
                    tiempoMinutos: permiso.tiempo,
                    observaciones: permiso.observaciones
                })),
                totalTiempoActividades: jornada.totalTiempoActividades
            };
        });

        res.status(200).json({
            success: true,
            total: reporteDetallado.length,
            data: reporteDetallado
        });

    } catch (error) {
        console.error('❌ Error al generar reporte de jornadas y permisos:', error);
        res.status(500).json({
            success: false,
            message: 'Error al generar el reporte',
            error: error.message
        });
    }
};

// @desc    Obtener jornadas paginadas (OPTIMIZACIÓN)
// @route   GET /api/jornadas/paginadas
exports.obtenerJornadasPaginadas = async (req, res) => {
    try {
        const { 
            page = 1, 
            limit = 10, 
            operario, 
            fechaInicio, 
            fechaFin,
            includeRegistros = 'false' 
        } = req.query;

        const skip = (page - 1) * limit;
        let operarios = [];

        // Filtros
        if (operario) {
            const Operario = require('../models/Operario');
            const operariosDocs = await Operario.find({
                name: { $regex: operario, $options: 'i' }
            }).select('_id');
            operarios = operariosDocs;
        }

        // Modificar query para obtener solo jornadas con registros de Horario/Permiso Laboral
        const Produccion = require('../models/Produccion');
        
        // Buscar registros que sean de tipo Horario Laboral o Permiso Laboral
        const registrosLaborales = await Produccion.find({
            tipoTiempo: { $in: ['Horario Laboral', 'Permiso Laboral'] },
            ...(fechaInicio || fechaFin ? { 
                fecha: {
                    ...(fechaInicio && { $gte: new Date(fechaInicio) }),
                    ...(fechaFin && { $lte: new Date(fechaFin) })
                }
            } : {}),
            ...(operarios.length > 0 ? {
                operario: { $in: operarios.map(op => op._id) }
            } : {})
        }).populate('operario', 'name');

        // Agrupar por operario y fecha para crear jornadas virtuales
        const jornadasMap = new Map();
        
        for (const registro of registrosLaborales) {
            const fechaKey = new Date(registro.fecha).toDateString();
            const operarioId = registro.operario._id.toString();
            const key = `${operarioId}-${fechaKey}`;
            
            if (!jornadasMap.has(key)) {
                jornadasMap.set(key, {
                    _id: key, // ID virtual
                    operario: registro.operario,
                    fecha: registro.fecha,
                    registros: [],
                    horaInicio: null,
                    horaFin: null
                });
            }
            
            jornadasMap.get(key).registros.push(registro);
        }

        // Convertir a array y aplicar paginación
        const todasLasJornadas = Array.from(jornadasMap.values());
        const total = todasLasJornadas.length;
        const jornadas = todasLasJornadas
            .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
            .slice(skip, skip + parseInt(limit));

        // Calcular tiempos basándose únicamente en registros de Horario/Permiso Laboral
        const jornadasOptimizadas = jornadas.map(jornada => {
            let tiempoEfectivoAPagar = { horas: 0, minutos: 0 };
            let horaInicio = null;
            let horaFin = null;
            
            // Filtrar registros por tipo
            const registrosHorarioLaboral = jornada.registros.filter(r => r.tipoTiempo === 'Horario Laboral');
            const registrosPermisoLaboral = jornada.registros.filter(r => r.tipoTiempo === 'Permiso Laboral');
            
            // Calcular horario laboral (hora inicio y fin)
            if (registrosHorarioLaboral.length > 0) {
                const horas = registrosHorarioLaboral
                    .filter(r => r.horaInicio && r.horaFin)
                    .map(r => ({
                        inicio: new Date(r.horaInicio),
                        fin: new Date(r.horaFin)
                    }));
                
                if (horas.length > 0) {
                    horaInicio = new Date(Math.min(...horas.map(h => h.inicio)));
                    horaFin = new Date(Math.max(...horas.map(h => h.fin)));
                    
                    // Ajustar si la hora fin es menor (día siguiente)
                    if (horaFin <= horaInicio) {
                        horaFin = new Date(horaFin.getTime() + 24 * 60 * 60 * 1000);
                    }
                    
                    // Calcular tiempo total de horario laboral
                    const tiempoTotalMinutos = Math.round((horaFin - horaInicio) / (1000 * 60));
                    
                    // Calcular tiempo de permisos NO remunerados para restar
                    const tiempoPermisosNoRemunerados = registrosPermisoLaboral
                        .filter(r => r.tipoPermiso && r.tipoPermiso.toLowerCase() === 'permiso no remunerado')
                        .reduce((total, permiso) => total + (permiso.tiempo || 0), 0);
                    
                    // Tiempo efectivo = Horario Laboral - Permisos NO Remunerados
                    const tiempoEfectivoMinutos = Math.max(0, tiempoTotalMinutos - tiempoPermisosNoRemunerados);
                    
                    tiempoEfectivoAPagar = {
                        horas: Math.floor(tiempoEfectivoMinutos / 60),
                        minutos: tiempoEfectivoMinutos % 60
                    };
                }
            } else if (registrosPermisoLaboral.length > 0) {
                // Caso: Solo hay permisos (sin horario laboral)
                // Calcular tiempo solo de permisos REMUNERADOS
                const tiempoPermisosRemunerados = registrosPermisoLaboral
                    .filter(r => r.tipoPermiso && r.tipoPermiso.toLowerCase() === 'permiso remunerado')
                    .reduce((total, permiso) => {
                        if (permiso.horaInicio && permiso.horaFin) {
                            const inicio = new Date(permiso.horaInicio);
                            let fin = new Date(permiso.horaFin);
                            
                            // Ajustar si la hora fin es menor (día siguiente)
                            if (fin <= inicio) {
                                fin = new Date(fin.getTime() + 24 * 60 * 60 * 1000);
                            }
                            
                            const minutos = Math.round((fin - inicio) / (1000 * 60));
                            return total + minutos;
                        }
                        return total + (permiso.tiempo || 0);
                    }, 0);
                
                tiempoEfectivoAPagar = {
                    horas: Math.floor(tiempoPermisosRemunerados / 60),
                    minutos: tiempoPermisosRemunerados % 60
                };
            }
            
            return {
                _id: jornada._id,
                operario: jornada.operario,
                fecha: jornada.fecha,
                horaInicio,
                horaFin,
                registros: includeRegistros === 'true' ? jornada.registros : [],
                tiempoEfectivoAPagar,
                totalTiempoActividades: { horas: 0, minutos: 0 } // Ya no relevante
            };
        });

        res.status(200).json({
            jornadas: jornadasOptimizadas,
            pagination: {
                currentPage: parseInt(page),
                totalPages: Math.ceil(total / limit),
                totalItems: total,
                itemsPerPage: parseInt(limit),
                hasNextPage: page * limit < total,
                hasPreviousPage: page > 1
            }
        });
    } catch (error) {
        console.error('Error fetching paged jornadas:', error);
        res.status(500).json({ error: 'Error al obtener jornadas paginadas' });
    }
};