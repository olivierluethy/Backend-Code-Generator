// Frontend data-access layer for posts, written with the Fetch API.
// `bcg analyze` reads this file to infer the Post entity, its fields and its
// CRUD operations — no backend code is written by hand.

export async function listPosts() {
  const res = await fetch("/api/posts");
  return res.json();
}

export async function getPost(id) {
  const res = await fetch(`/api/posts/${id}`);
  return res.json();
}

export async function createPost(data) {
  const res = await fetch("/api/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: data.title,
      body: data.body,
      views: 0,
    }),
  });
  return res.json();
}

export async function updatePost(id, data) {
  const res = await fetch(`/api/posts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: data.title,
      body: data.body,
      published: true,
    }),
  });
  return res.json();
}

export async function deletePost(id) {
  await fetch(`/api/posts/${id}`, { method: "DELETE" });
}
