// Comments data-access layer, written with axios. The analyzer recognises the
// axios.<method>(url, data) shape just as it does fetch().

import axios from "axios";

export const listComments = () => axios.get("/api/comments");

export const getComment = (id) => axios.get(`/api/comments/${id}`);

export const addComment = (payload) =>
  axios.post("/api/comments", {
    author: payload.author,
    content: payload.content,
  });

export const removeComment = (id) => axios.delete(`/api/comments/${id}`);
