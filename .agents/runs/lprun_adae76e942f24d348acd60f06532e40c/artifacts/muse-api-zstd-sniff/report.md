STATUS: complete

# Decode zstd API bodies without content-encoding header

The cookie API client decodes zstd-compressed responses from the Muse VM even when the response has no content-encoding header.

Attempt 1 accepted by Lane Pilot BB writer.
