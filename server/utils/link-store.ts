import type { LinkSchema } from '#shared/schemas/link'
import type { H3Event } from 'h3'
import type { z } from 'zod'
import { parseURL, stringifyParsedURL } from 'ufo'

type Link = z.infer<typeof LinkSchema>

export function withoutQuery(url: string): string {
  const parsed = parseURL(url)
  return stringifyParsedURL({ ...parsed, search: '' })
}

// Cloudflare KV limits per-key metadata to 1024 bytes (serialized JSON).
// We mirror url/comment into metadata so listLinks/search can avoid a value
// read per key. Long URLs would blow past this limit and cause a
// 413 Payload Too Large on PUT, so we store only a prefix and flag it as
// truncated; the full URL still lives in the link value (read on edit/redirect).
const KV_METADATA_LIMIT = 1024
// Headroom left over the 1024-byte limit for JSON structure and rounding.
const KV_METADATA_SAFETY_MARGIN = 32
// Comments are secondary in search; cap their share of the metadata budget.
const METADATA_COMMENT_BUDGET = 256

export interface LinkMetadata {
  expiration?: number
  url?: string
  comment?: string
  // Set when `url` holds only a prefix of the real target (see buildLinkMetadata).
  truncated?: boolean
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function truncateToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0)
    return ''
  if (byteLength(value) <= maxBytes)
    return value
  // Trim by code point so we never split a multi-byte character.
  let end = value.length
  while (end > 0 && byteLength(value.slice(0, end)) > maxBytes)
    end--
  return value.slice(0, end)
}

export function buildLinkMetadata(link: Link, expiration?: number): LinkMetadata {
  const metadata: LinkMetadata = { expiration }
  if (link.comment)
    metadata.comment = truncateToBytes(link.comment, METADATA_COMMENT_BUDGET)

  const url = withoutQuery(link.url)
  // Bytes left for the URL after structure + expiration + comment + flags.
  const reserved = byteLength(JSON.stringify({ ...metadata, url: '', truncated: true }))
  const urlBudget = KV_METADATA_LIMIT - reserved - KV_METADATA_SAFETY_MARGIN
  if (byteLength(url) > urlBudget) {
    metadata.url = truncateToBytes(url, urlBudget)
    metadata.truncated = true
  }
  else {
    metadata.url = url
  }

  return metadata
}

export function normalizeSlug(event: H3Event, slug: string): string {
  const { caseSensitive } = useRuntimeConfig(event)
  return caseSensitive ? slug : slug.toLowerCase()
}

export function buildShortLink(event: H3Event, slug: string): string {
  return `${getRequestProtocol(event)}://${getRequestHost(event)}/${slug}`
}

export async function putLink(event: H3Event, link: Link): Promise<void> {
  const { cloudflare } = event.context
  const { KV } = cloudflare.env
  const expiration = getExpiration(event, link.expiration)

  await KV.put(`link:${link.slug}`, JSON.stringify(link), {
    expiration,
    metadata: buildLinkMetadata(link, expiration),
  })
}

export async function getLink(event: H3Event, slug: string, cacheTtl?: number): Promise<Link | null> {
  const { cloudflare } = event.context
  const { KV } = cloudflare.env
  return await KV.get(`link:${slug}`, { type: 'json', cacheTtl }) as Link | null
}

export async function getLinkWithMetadata(event: H3Event, slug: string): Promise<{ link: Link | null, metadata: Record<string, unknown> | null }> {
  const { cloudflare } = event.context
  const { KV } = cloudflare.env
  const { metadata, value: link } = await KV.getWithMetadata(`link:${slug}`, { type: 'json' })
  return { link: link as Link | null, metadata: metadata as Record<string, unknown> | null }
}

export async function deleteLink(event: H3Event, slug: string): Promise<void> {
  const { cloudflare } = event.context
  const { KV } = cloudflare.env
  await KV.delete(`link:${slug}`)
}

export async function linkExists(event: H3Event, slug: string): Promise<boolean> {
  const link = await getLink(event, slug)
  return link !== null
}

interface ListLinksOptions {
  limit: number
  cursor?: string
}

interface ListLinksResult {
  links: (Link | null)[]
  list_complete: boolean
  cursor?: string
}

export async function listLinks(event: H3Event, options: ListLinksOptions): Promise<ListLinksResult> {
  const { cloudflare } = event.context
  const { KV } = cloudflare.env
  const list = await KV.list({
    prefix: 'link:',
    limit: options.limit,
    cursor: options.cursor || undefined,
  })

  const links = await Promise.all(
    (list.keys || []).map(async (key: { name: string }) => {
      const { metadata, value: link } = await KV.getWithMetadata(key.name, { type: 'json' }) as { metadata: Record<string, unknown> | null, value: Link | null }
      if (link) {
        return {
          ...(metadata ?? {}),
          ...link,
        }
      }
      return link
    }),
  )

  return {
    links,
    list_complete: list.list_complete,
    cursor: 'cursor' in list ? list.cursor : undefined,
  }
}
