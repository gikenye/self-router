import { getMetaGoalsCollection } from "../lib/database";

async function updateGoalsSchema() {
  const collection = await getMetaGoalsCollection();
  
  await collection.updateMany(
    { invitedUsers: { $exists: false } },
    { $set: { invitedUsers: [] } }
  );

  await collection.updateMany(
    { isPublic: { $exists: false } },
    { $set: { isPublic: true } }
  );

  await collection.updateMany(
    { participants: { $exists: false } },
    { $set: { participants: [] } }
  );

  const result = await collection.updateMany(
    { participants: { $size: 0 } },
    [{ $set: { participants: ["$creatorAddress"] } }]
  );

  console.log("✅ Schema updated:", result.modifiedCount, "goals modified");
  process.exit(0);
}

updateGoalsSchema().catch(console.error);
