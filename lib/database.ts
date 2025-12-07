import { MongoClient, Db, Collection } from "mongodb";
import type { MetaGoal } from "./types";

let client: MongoClient | null = null;
let db: Db | null = null;

function extractDbNameFromUri(uri: string): string | null {
  const match = uri.match(/\/([^/?]+)(\?|$)/);
  return match ? match[1] : null;
}

export async function connectToDatabase(): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI environment variable is required");
  }

  const dbName = process.env.MONGODB_DB_NAME || extractDbNameFromUri(uri);
  if (!dbName) {
    throw new Error("Database name not found in URI or MONGODB_DB_NAME");
  }

  client = new MongoClient(uri);
  await client.connect();
  db = client.db(dbName);

  if (process.env.LOG_DB_CONNECTION === "true") {
    console.log("✅ Connected to MongoDB");
  }

  return db;
}

export async function getMetaGoalsCollection(): Promise<Collection<MetaGoal>> {
  const database = await connectToDatabase();
  return database.collection<MetaGoal>("meta_goals");
}

export async function closeConnection(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
