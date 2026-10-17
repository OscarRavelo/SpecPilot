---
id: TASK-101
type: endpoint-fields
---
# Add phone field to POST /users

## Context
User sign-up must accept an optional phone number.

## Acceptance criteria

### AC-1: Stores the phone when present in the payload
- Given a valid payload with `phone: "+34600000000"`
- When POST /users is called
- Then it responds 201 and the stored user includes `phone`

### AC-2: Rejects phones with an invalid format
- Given a payload with `phone: "abc"`
- When POST /users is called
- Then it responds 400 with `error.code = "INVALID_PHONE"`
