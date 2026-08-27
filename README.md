# Backend Code Generator

A deterministic, rule-based generator that turns a small **entity spec** into a
runnable backend — **no AI, no network**. Same spec in → same code out.

Two deterministic stages, both driven by the same JSON contract:

1. **`analyze`** — read a frontend project and *produce* the spec.
2. **`generate`** — turn a spec into a runnable backend.

You can run them separately (analyze → review/edit the spec → generate) or
chain them in one command.

## Usage

```bash
npm install                       # (only needed if you extend the generator)

# 1. Infer a spec from a frontend, then review it:
node bin/cli.js analyze examples/frontend --out spec.json

# 2. Generate the backend from that spec:
node bin/cli.js generate spec.json --out ./out/api

# ...or do both at once:
node bin/cli.js analyze examples/frontend --generate ./out/api
```

Then run the generated API:

```bash
cd out/api
npm install
npm start        # -> API listening on http://localhost:3000
```

Try it:

```bash
curl -X POST localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"Hello","body":"world","views":1}'
curl localhost:3000/posts
```

## Frontend analysis (`analyze`)

`analyze` scans a frontend directory and derives the backend requirements from
how the frontend *talks to* its API. It is purely rule-based and offline: the
same frontend always yields the same spec.

### What it reads

- **HTTP calls** — `fetch(url, { method, body })` and
  `axios.get/post/put/patch/delete(url, data)` (plus `axios({ url, method, data })`).
- **HTML/JSX forms** — `<input>`, `<textarea>`, `<select>` `name`s (and the
  `<form action>`), merged into the entity that file writes to.

Source files with these extensions are scanned: `.js .jsx .ts .tsx .mjs .cjs
.vue .svelte .html`. `node_modules`, `dist`, `build`, `.git`, and similar
directories are skipped. Comments are ignored.

### The rules

| Frontend signal | Backend inference |
| --- | --- |
| URL path (`/api/posts`, `/api/posts/:id`) | entity name — last plural segment, `api`/`vN` prefix and path params stripped, singularized to PascalCase (`Post`) |
| `GET` collection / `GET` item | `list` / `show` |
| `POST` / `PUT`·`PATCH` / `DELETE` | `create` / `update` / `remove` |
| request-body keys, form field names | entity fields |
| field name & literal value | field type (see below) |

**Field types** are inferred deterministically: a literal value wins
(`views: 0` → integer, `published: true` → boolean); otherwise the name decides
(`is_*`/`published`/`active` → boolean; `*_id`/`count`/`views`/`age` → integer;
`price`/`amount`/`rate` → float; `body`/`content`/`description` → text); the
fallback is `string`. `<input type="number">` → integer,
`type="checkbox">` → boolean.

### Traceability

For every entity, `analyze` prints which frontend files and lines produced each
field and operation — so you can see exactly why each backend component exists:

```
Post
    operations: list, show, create, update, remove
    field title (string)  <- api.js:16, new-post.html:14
    field body (text)     <- api.js:17
    field views (integer) <- api.js:18, new-post.html:16
```

### Review before generation

`analyze` writes an editable `spec.json` and stops (unless `--generate` is
given). Review/adjust it — mark required fields, rename entities, fix an
inferred type — then run `generate`. The spec is the contract you stay in
control of.

### Known limitations

The analyzer favours predictability over cleverness — it is regex/heuristic
based, not a full parser:

- Only `fetch`/`axios` are recognised (not `XMLHttpRequest`, `$.ajax`, or
  wrapper clients). Request bodies must be **object literals** (or
  `JSON.stringify({...})`); bodies passed as a variable or `FormData` yield no
  fields.
- `required` is never inferred (always `false`) — set it in the spec.
- Detected operations are shown in the trace, but the generator always emits
  full CRUD for each entity.
- Nested collection routes (`/posts/:id/comments`) map to the last resource;
  entity **relationships** are not yet inferred.
- Naive singularization/pluralization (`categories`→`Category`, `boxes`→`Box`);
  irregular nouns may need a manual fix in the spec.

## Spec format

```json
{
  "projectName": "blog-api",
  "target": "node",
  "entities": [
    { "name": "Post", "fields": [
      { "name": "title", "type": "string", "required": true },
      { "name": "body",  "type": "text" },
      { "name": "views", "type": "integer" }
    ]}
  ]
}
```

Field types: `string | text | integer | boolean | float`.

## What it generates

For each entity: a migration, a model, a controller (with required-field
validation + JSON errors) and REST routes — plus `app.js`, `db.js` and a
`package.json`, in a standard structure:

```
out/blog-api/
  app.js  db.js  package.json
  migrations/001_create_posts.sql ...
  models/Post.js ...
  controllers/PostController.js ...
  routes/posts.routes.js ...
```

Every entity yields full CRUD: `GET /posts`, `GET /posts/:id`, `POST /posts`,
`PUT /posts/:id`, `DELETE /posts/:id`. The CLI prints a **traceability** map of
which entity produced which files.

## Scope (issue #1)

**Implemented:** deterministic rule-based generation; frontend analysis
(auto-producing the spec from fetch/axios calls and forms, with traceability
and a review step); standard project structure
(migrations/models/controllers/routes); full CRUD; basic validation and error
handling; traceability output; Node.js target.

**Deferred (follow-up slices):** a PHP target (`src/templates/php/` sibling),
entity relationships, auth, services layer, generated tests, and version-diff
regeneration. The JSON spec is intentionally the stable contract those stages
build around.
