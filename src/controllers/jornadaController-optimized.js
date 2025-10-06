// Nuevo endpoint optimizado para el backend
// backend/src/controllers/jornadaController.js

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
        let query = {};

        // Filtros
        if (operario) {
            const operarios = await Operario.find({
                name: { $regex: operario, $options: 'i' }
            }).select('_id');
            query.operario = { $in: operarios.map(op => op._id) };
        }

        if (fechaInicio || fechaFin) {
            query.fecha = {};
            if (fechaInicio) query.fecha.$gte = new Date(fechaInicio);
            if (fechaFin) query.fecha.$lte = new Date(fechaFin);
        }

        // Solo incluir jornadas con registros
        query.registros = { $exists: true, $not: { $size: 0 } };

        // Contar total de documentos
        const total = await Jornada.countDocuments(query);

        // Construir query principal
        let jornadaQuery = Jornada.find(query)
            .populate('operario', 'name')
            .sort({ fecha: -1 })
            .skip(skip)
            .limit(parseInt(limit));

        // Solo hacer populate de registros si se solicita explícitamente
        if (includeRegistros === 'true') {
            jornadaQuery = jornadaQuery.populate({
                path: 'registros',
                populate: [
                    { path: 'procesos', model: 'Proceso', select: 'nombre' },
                    { path: 'oti', select: 'numeroOti' },
                    { path: 'areaProduccion', select: 'nombre' },
                    { path: 'maquina', model: 'Maquina', select: 'nombre' }
                ]
            });
        }

        const jornadas = await jornadaQuery;

        // Calcular tiempos de forma optimizada
        const jornadasOptimizadas = jornadas.map(jornada => ({
            _id: jornada._id,
            operario: jornada.operario,
            fecha: jornada.fecha,
            horaInicio: jornada.horaInicio,
            horaFin: jornada.horaFin,
            registros: includeRegistros === 'true' ? jornada.registros : [],
            tiempoEfectivoAPagar: calcularTiempoEfectivoOptimizado(jornada),
            totalTiempoActividades: jornada.totalTiempoActividades || { horas: 0, minutos: 0 }
        }));

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
        res.status(500).json({ error: 'Error al obtener jornadas paginadas' });
    }
};

// Función optimizada para calcular tiempo efectivo
function calcularTiempoEfectivoOptimizado(jornada) {
    if (jornada.horaInicio && jornada.horaFin) {
        const inicio = new Date(jornada.horaInicio);
        let fin = new Date(jornada.horaFin);
        
        if (fin <= inicio) {
            fin = new Date(fin.getTime() + 24 * 60 * 60 * 1000);
        }
        
        const tiempoTotalMinutos = Math.round((fin - inicio) / (1000 * 60));
        
        return {
            horas: Math.floor(tiempoTotalMinutos / 60),
            minutos: tiempoTotalMinutos % 60
        };
    }
    
    return jornada.totalTiempoActividades || { horas: 0, minutos: 0 };
}