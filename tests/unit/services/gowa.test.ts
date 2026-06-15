/**
 * Unit tests for Go-Wa incoming message webhook handler.
 * Validates Requirements: 3.2, 3.3, 3.6, 3.7
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleIncomingMessage, handleMediaMessage } from '../../../src/services/gowa';
import { createMockD1, createMockR2 } from '../../helpers';
import type { GoWaWebhookPayload, GoWaMediaPayload } from '../../../src/types';

type MockD1 = ReturnType<typeof createMockD1> & {
  _setNextResults: (results: Record<string, unknown>[]) => void;
  _mockResults: Record<string, unknown>[][];
  _queries: Array<{ sql: string; params: unknown[] }>;
};

describe('Go-Wa Incoming Message Handler', () => {
  let mockDb: MockD1;
  let mockR2: R2Bucket;
  const tenantId = 'tenant-123';

  beforeEach(() => {
    mockDb = createMockD1() as unknown as MockD1;
    mockR2 = createMockR2();
    vi.restoreAllMocks();
  });

  describe('handleIncomingMessage', () => {
    describe('Contact Linking (Req 3.2)', () => {
      it('should link message to contact when phone number matches existing contact', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+6281234567890',
          message: 'Hello agent',
          type: 'text',
          timestamp: Date.now(),
        };

        // Contact lookup returns a match
        mockDb._setNextResults([{ id: 'contact-abc' }]);

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        expect(result.contact_id).toBe('contact-abc');
        expect(result.channel).toBe('gowa');
        expect(result.delivery_status).toBe('delivered');
        expect(result.content).toBe('Hello agent');
        expect(result.sender).toBe('+6281234567890');

        // Verify the contact lookup query
        const lookupQuery = mockDb._queries[0]!;
        expect(lookupQuery.sql).toContain('SELECT id FROM contacts WHERE tenant_id = ? AND phone_number = ?');
        expect(lookupQuery.params[0]).toBe(tenantId);
        expect(lookupQuery.params[1]).toBe('+6281234567890');

        // Verify INSERT includes is_unlinked=0
        const insertQuery = mockDb._queries[1]!;
        expect(insertQuery.sql).toContain('INSERT INTO messages');
        expect(insertQuery.params).toContain('contact-abc');
        // is_unlinked = 0
        expect(insertQuery.params[11]).toBe(0);
      });

      it('should store message with correct fields when contact is linked', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+1234567890',
          message: 'Test message',
          type: 'text',
          timestamp: 1700000000,
        };

        mockDb._setNextResults([{ id: 'contact-xyz' }]);

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        expect(result.tenant_id).toBe(tenantId);
        expect(result.contact_id).toBe('contact-xyz');
        expect(result.message_type).toBe('text');
        expect(result.media_url).toBeNull();
        expect(result.id).toBeDefined();
        expect(result.created_at).toBeDefined();
      });
    });

    describe('Unlinked Messages (Req 3.6)', () => {
      it('should mark message as unlinked when phone number does not match any contact', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+9999999999',
          message: 'Unknown sender message',
          type: 'text',
          timestamp: Date.now(),
        };

        // Contact lookup returns no match
        mockDb._setNextResults([]);

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        expect(result.contact_id).toBeNull();

        // Verify INSERT has is_unlinked=1 and sender_phone set
        const insertQuery = mockDb._queries[1]!;
        expect(insertQuery.sql).toContain('INSERT INTO messages');
        // sender_phone is payload.from
        expect(insertQuery.params[10]).toBe('+9999999999');
        // is_unlinked = 1
        expect(insertQuery.params[11]).toBe(1);
      });

      it('should store sender_phone when contact is not found', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+6280000000000',
          message: 'From unknown',
          type: 'text',
          timestamp: Date.now(),
        };

        mockDb._setNextResults([]);

        await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        // Verify sender_phone in the INSERT params
        const insertQuery = mockDb._queries[1]!;
        expect(insertQuery.params[10]).toBe('+6280000000000');
      });

      it('should set sender_phone to null when contact IS found', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+6281234567890',
          message: 'Known sender',
          type: 'text',
          timestamp: Date.now(),
        };

        mockDb._setNextResults([{ id: 'known-contact' }]);

        await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        // sender_phone should be null when contact is linked
        const insertQuery = mockDb._queries[1]!;
        expect(insertQuery.params[10]).toBeNull();
      });
    });

    describe('Media Messages (Req 3.3, 3.7)', () => {
      it('should upload media to R2 when size is within 16MB limit', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+6281234567890',
          message: 'Image caption',
          type: 'image',
          timestamp: Date.now(),
          media_url: 'https://gowa.example.com/media/abc123.jpg',
          media_size: 5 * 1024 * 1024, // 5MB
        };

        // Contact lookup - found
        mockDb._setNextResults([{ id: 'contact-media' }]);

        // Mock global fetch for media download
        const mockFetch = vi.fn().mockResolvedValue(
          new Response(new ArrayBuffer(100), { status: 200 })
        );
        vi.stubGlobal('fetch', mockFetch);

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        // Should have a media_url (R2 key)
        expect(result.media_url).toContain(`${tenantId}/media/whatsapp/`);
        expect(result.media_url).toContain('.jpg');
        expect(result.message_type).toBe('image');

        // Verify fetch was called with the media URL
        expect(mockFetch).toHaveBeenCalledWith(
          'https://gowa.example.com/media/abc123.jpg',
          expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
      });

      it('should flag oversized media (> 16MB) without storing media binary', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+6281234567890',
          message: 'Large file',
          type: 'video',
          timestamp: Date.now(),
          media_url: 'https://gowa.example.com/media/large-video.mp4',
          media_size: 20 * 1024 * 1024, // 20MB - exceeds limit
        };

        // Contact lookup
        mockDb._setNextResults([{ id: 'contact-big' }]);

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        // media_url should be null (not stored)
        expect(result.media_url).toBeNull();

        // Verify INSERT has oversized_media=1
        const insertQuery = mockDb._queries[1]!;
        // oversized_media is the 13th param (index 12)
        expect(insertQuery.params[12]).toBe(1);
      });

      it('should NOT flag as oversized when media is exactly 16MB', async () => {
        const exactLimit = 16 * 1024 * 1024; // exactly 16MB
        const payload: GoWaWebhookPayload = {
          from: '+6281234567890',
          message: 'Exactly 16MB',
          type: 'document',
          timestamp: Date.now(),
          media_url: 'https://gowa.example.com/media/exact.pdf',
          media_size: exactLimit,
        };

        mockDb._setNextResults([{ id: 'contact-exact' }]);

        const mockFetch = vi.fn().mockResolvedValue(
          new Response(new ArrayBuffer(exactLimit), { status: 200 })
        );
        vi.stubGlobal('fetch', mockFetch);

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        // Should be stored (not oversized)
        expect(result.media_url).not.toBeNull();

        // oversized_media = 0
        const insertQuery = mockDb._queries[1]!;
        expect(insertQuery.params[12]).toBe(0);
      });

      it('should store message without media_url when no media is present', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+6281234567890',
          message: 'Plain text',
          type: 'text',
          timestamp: Date.now(),
          // No media_url field
        };

        mockDb._setNextResults([{ id: 'contact-text' }]);

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        expect(result.media_url).toBeNull();
        expect(result.message_type).toBe('text');
      });
    });

    describe('Message Type Normalization', () => {
      it('should normalize valid message types', async () => {
        for (const type of ['text', 'image', 'video', 'audio', 'document']) {
          mockDb._setNextResults([]);
          const payload: GoWaWebhookPayload = {
            from: '+1111111111',
            message: `Type: ${type}`,
            type,
            timestamp: Date.now(),
          };

          const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);
          expect(result.message_type).toBe(type);
        }
      });

      it('should default to text for unknown message types', async () => {
        mockDb._setNextResults([]);
        const payload: GoWaWebhookPayload = {
          from: '+1111111111',
          message: 'Unknown type',
          type: 'sticker',
          timestamp: Date.now(),
        };

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);
        expect(result.message_type).toBe('text');
      });
    });

    describe('D1 Storage (Req 3.5)', () => {
      it('should store message with all required fields in D1', async () => {
        const payload: GoWaWebhookPayload = {
          from: '+6281234567890',
          message: 'Complete message',
          type: 'text',
          timestamp: 1700000000,
        };

        mockDb._setNextResults([{ id: 'contact-full' }]);

        const result = await handleIncomingMessage(tenantId, payload, mockDb as unknown as D1Database, mockR2);

        const insertQuery = mockDb._queries[1]!;
        expect(insertQuery.sql).toContain('INSERT INTO messages');

        // Verify all important fields are in the INSERT
        // Params order: id, tenant_id, contact_id, sender, recipient, message_type,
        //               content, media_url, delivery_status, channel, sender_phone,
        //               is_unlinked, oversized_media, created_at, updated_at
        expect(insertQuery.params[1]).toBe(tenantId); // tenant_id
        expect(insertQuery.params[2]).toBe('contact-full'); // contact_id
        expect(insertQuery.params[3]).toBe('+6281234567890'); // sender
        expect(insertQuery.params[5]).toBe('text'); // message_type
        expect(insertQuery.params[6]).toBe('Complete message'); // content
        expect(insertQuery.params[8]).toBe('delivered'); // delivery_status
        expect(insertQuery.params[9]).toBe('gowa'); // channel
      });
    });
  });

  describe('handleMediaMessage', () => {
    it('should download media and upload to R2 under tenant namespace', async () => {
      const mediaContent = new ArrayBuffer(1024);
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(mediaContent, { status: 200 })
      );
      vi.stubGlobal('fetch', mockFetch);

      const payload: GoWaMediaPayload = {
        media_url: 'https://gowa.example.com/media/photo.jpg',
        media_size: 1024,
        content_type: 'image/jpeg',
        filename: 'photo.jpg',
        message_id: 'msg-123',
      };

      const r2Key = await handleMediaMessage(tenantId, payload, mockR2);

      expect(r2Key).toBe(`${tenantId}/media/whatsapp/msg-123/photo.jpg`);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://gowa.example.com/media/photo.jpg',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    });

    it('should return null when media download fails', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(null, { status: 404 })
      );
      vi.stubGlobal('fetch', mockFetch);

      const payload: GoWaMediaPayload = {
        media_url: 'https://gowa.example.com/media/missing.jpg',
        media_size: 1024,
        content_type: 'image/jpeg',
        filename: 'missing.jpg',
        message_id: 'msg-404',
      };

      const r2Key = await handleMediaMessage(tenantId, payload, mockR2);

      expect(r2Key).toBeNull();
    });

    it('should return null when fetch throws an error (network failure)', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
      vi.stubGlobal('fetch', mockFetch);

      const payload: GoWaMediaPayload = {
        media_url: 'https://gowa.example.com/media/unreachable.jpg',
        media_size: 1024,
        content_type: 'image/jpeg',
        filename: 'unreachable.jpg',
        message_id: 'msg-err',
      };

      const r2Key = await handleMediaMessage(tenantId, payload, mockR2);

      expect(r2Key).toBeNull();
    });

    it('should use correct R2 key pattern: {tenant_id}/media/whatsapp/{message_id}/{filename}', async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(new ArrayBuffer(50), { status: 200 })
      );
      vi.stubGlobal('fetch', mockFetch);

      const payload: GoWaMediaPayload = {
        media_url: 'https://gowa.example.com/media/doc.pdf',
        media_size: 50,
        content_type: 'application/pdf',
        filename: 'important-doc.pdf',
        message_id: 'msg-pdf-001',
      };

      const r2Key = await handleMediaMessage('tenant-abc', payload, mockR2);

      expect(r2Key).toBe('tenant-abc/media/whatsapp/msg-pdf-001/important-doc.pdf');
    });
  });
});
