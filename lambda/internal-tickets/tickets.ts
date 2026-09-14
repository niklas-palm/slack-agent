// The ticket store the internal API serves.
//
// Tickets have real state, so the store lives here and the handler above only
// does auth and shape.
//
// Every function takes the caller's verified `subject` and uses it as the
// partition key. That is the authorization: you cannot read, modify or address a
// ticket outside your own partition, because the key is built from the token's
// `sub` rather than from anything in the request. No group claim could express
// this, which is why it lives here rather than in Okta.
import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const TABLE = process.env.TICKETS_TABLE!;

export type Status = 'open' | 'waiting' | 'closed';

export interface Ticket {
  id: string;
  title: string;
  status: Status;
  updated: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const toTicket = (i: Record<string, unknown>): Ticket => ({
  id: String(i.ticket_id),
  title: String(i.title),
  status: i.status as Status,
  updated: String(i.updated),
});

export async function list(subject: string): Promise<Ticket[]> {
  const out = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'subject = :s',
      ExpressionAttributeValues: { ':s': subject },
    }),
  );
  return (out.Items ?? []).map(toTicket);
}

export async function create(subject: string, title: string): Promise<Ticket> {
  const ticket: Ticket = {
    id: `REQ-${randomUUID().slice(0, 8)}`,
    title,
    status: 'open',
    updated: today(),
  };
  const { id, ...rest } = ticket;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { subject, ticket_id: id, ...rest } }));
  return ticket;
}

/** Returns undefined when the ticket is not in this subject's partition. */
export async function update(
  subject: string,
  id: string,
  fields: { title?: string; status?: Status },
): Promise<Ticket | undefined> {
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { subject, ticket_id: id } }),
  );
  if (!existing.Item) return undefined;

  const out = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { subject, ticket_id: id },
      UpdateExpression: 'SET title = :t, #s = :st, updated = :u',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':t': fields.title ?? existing.Item.title,
        ':st': fields.status ?? existing.Item.status,
        ':u': today(),
      },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return toTicket(out.Attributes!);
}
