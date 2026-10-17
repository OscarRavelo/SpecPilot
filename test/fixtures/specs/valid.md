---
id: TASK-101
type: endpoint-fields
---
# Añadir campo phone a POST /users

## Contexto
El alta de usuarios debe aceptar un teléfono opcional.

## Criterios de aceptación

### AC-1: Guarda el teléfono cuando viene en el payload
- Given un payload válido con `phone: "+34600000000"`
- When se hace POST /users
- Then responde 201 y el usuario guardado incluye `phone`

### AC-2: Rechaza teléfonos con formato inválido
- Given un payload con `phone: "abc"`
- When se hace POST /users
- Then responde 400 con `error.code = "INVALID_PHONE"`
