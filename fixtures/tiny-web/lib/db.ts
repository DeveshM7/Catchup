import postgres from "postgres";

const sql = postgres();

export function saveChat() {
  return sql.unsafe("insert into chats default values");
}

export function listChats() {
  return sql.unsafe("select * from chats");
}

export function deleteChat() {
  return sql.unsafe("delete from chats where id = 1");
}

export function clearChats() {
  return sql.unsafe("delete from chats");
}

export function renameChat(title: string) {
  return sql.unsafe("update chats set title = $1", [title]);
}
