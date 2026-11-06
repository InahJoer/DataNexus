# Benchmark del motor de Cross-Joins (issue #30)

Mide el join en memoria con **100.000 filas por fuente**. Cubre los cuatro tipos de join y un join de tres fuentes con llave compuesta.

Solo cuenta el join y el aplanado de las filas (`executeJoinPlan` + `createRowFlattener`). No incluye la extracción, que depende de la red y del motor de cada fuente.

## Cómo ejecutarlo

```bash
cd backend
npm run bench:join
```

El código está en `src/data-engine/join/join-plan.benchmark.spec.ts`. Solo corre con `npm run bench:join` (`--mode benchmark`): en `npm test` se omite para no competir por CPU con las pruebas que miden tiempos.

## Datos de prueba

| Fuente | Filas | Detalle |
| --- | --- | --- |
| `clientes` | 100.000 | `id`, `nombre`, `email`, `pais` |
| `pedidos` | 100.000 | El 90 % apunta a un cliente existente y el 10 % a uno inexistente, para que LEFT, RIGHT y FULL difieran de INNER. La llave es texto y el `id` del cliente es número; coinciden igual. |
| `envios` | 100.000 | Llave compuesta `pedido` + `cliente`. |

## Resultados

Equipo: Intel Core i7-1165G7 (8 hilos, 16 GB) y Node.js 24.20.0. Las cifras son la mediana de 3 ejecuciones.

| Join | Filas de salida | Tiempo | Memoria aprox. |
| --- | ---: | ---: | ---: |
| INNER `clientes x pedidos` | 90.000 | 169 ms | ~61 MB |
| LEFT `clientes x pedidos` | 100.000 | 168 ms | ~61 MB |
| RIGHT `clientes x pedidos` | 100.000 | 170 ms | ~60 MB |
| FULL `clientes x pedidos` | 110.000 | 166 ms | ~67 MB |
| INNER + LEFT `clientes x pedidos x envios` (llave compuesta) | 90.000 | 276 ms | ~67 MB |

La memoria es el aumento del heap durante cada caso, con el recolector ejecutado justo antes (`--expose-gc`). Incluye las filas de salida ya aplanadas.

## Lectura

- **Complejidad lineal.** Cada relación construye un índice hash de la fuente nueva y recorre una vez el resultado acumulado: O(N + M) por relación. Unir una tercera fuente cuesta más o menos lo mismo que la primera relación.
- **Límites de memoria.** Las filas intermedias solo guardan referencias a los registros originales y se copian una vez, al aplanarlas. Cada resultado intermedio respeta `DATA_ENGINE_MAX_JOIN_ROWS` (100.000 por defecto) y el resultado final `DATA_ENGINE_MAX_JOIN_BYTES`. Si se supera alguno, el motor responde 413 sin agotar la memoria.
- **Cuello de botella real.** Con los límites por defecto (10.000 filas y 32 MB por fuente), lo que más tarda es la extracción desde cada motor, no el join.
