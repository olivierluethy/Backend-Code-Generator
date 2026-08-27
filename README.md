# Backend Code Generator

A deterministic, rule-based generator that turns a small **entity spec** into a
runnable backend — **no AI, no network**. Same spec in → same code out.

This is the MVP core (issue #1): the deterministic **spec → backend** engine.
Frontend analysis (reading a frontend to *produce* the spec) is a later stage
that simply emits the same JSON contract this tool already consumes.

## Usage

```bash
npm install                       # (only needed if you extend the generator)
node bin/cli.js generate examples/blog.json --out ./out/blog-api
```

Then run the generated API:

```bash
cd out/blog-api
npm install
npm start        # -> API listening on http://localhost:3000
```

Try it:

```bash
curl -X POST localhost:3000/posts -H 'Content-Type: application/json' \
  -d '{"title":"Hello","body":"world","views":1}'
curl localhost:3000/posts
```

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

**Implemented:** deterministic rule-based generation; standard project
structure (migrations/models/controllers/routes); full CRUD; basic validation
and error handling; traceability output; Node.js target.

**Deferred (follow-up slices):** frontend analysis (auto-producing the spec),
a PHP target (`src/templates/php/` sibling), entity relationships, auth,
services layer, generated tests, and version-diff regeneration. The JSON spec
is intentionally the stable contract those stages build around.
