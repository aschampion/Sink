import type { Link } from '#shared/schemas/link'
import type { LinkSearchItem } from '#shared/types/link'

defineRouteMeta({
  openAPI: {
    description: 'Search all links (returns slug, url, comment for each link)',
    security: [{ bearerAuth: [] }],
  },
})

interface LinkMetadata {
  url?: string
  comment?: string
  expiration?: number
}

export default eventHandler(async (event) => {
  const { cloudflare } = event.context
  const { KV } = cloudflare.env
  const list: LinkSearchItem[] = []
  let finalCursor: string | undefined

  try {
    while (true) {
      const result = await KV.list({
        prefix: `link:`,
        limit: 1000,
        cursor: finalCursor,
      }) as { keys: Array<{ name: string, metadata?: LinkMetadata }>, list_complete: boolean, cursor?: string }

      finalCursor = result.cursor

      if (Array.isArray(result.keys)) {
        for (const key of result.keys) {
          try {
            if (key.metadata?.url) {
              list.push({
                slug: key.name.replace('link:', ''),
                url: key.metadata.url,
                comment: key.metadata.comment,
              })
            }
            else {
              // Metadata is missing the url. Two cases:
              //  - Legacy link stored before metadata existed (metadata == null):
              //    read the value and backfill metadata once.
              //  - Long-URL link whose url doesn't fit KV's 1024-byte metadata
              //    limit (metadata present, url intentionally omitted): read the
              //    value for display but do NOT re-put, or we'd churn on every search.
              const { metadata, value: link } = await KV.getWithMetadata(key.name, { type: 'json' }) as { metadata: LinkMetadata | null, value: Link | null }
              if (link) {
                list.push({
                  slug: key.name.replace('link:', ''),
                  url: withoutQuery(link.url),
                  comment: link.comment,
                })
                if (metadata == null) {
                  const expiration = getExpiration(event, link.expiration)
                  await KV.put(key.name, JSON.stringify(link), {
                    expiration,
                    metadata: buildLinkMetadata(link, expiration),
                  })
                }
              }
            }
          }
          catch (err) {
            console.error(`Error processing key ${key.name}:`, err)
            continue // Skip this key and continue with the next one
          }
        }
      }

      if (!result.keys || result.list_complete) {
        break
      }
    }
    return list
  }
  catch (err) {
    console.error('Error fetching link list:', err)
    throw createError({
      status: 500,
      statusText: 'Failed to fetch link list',
    })
  }
})
