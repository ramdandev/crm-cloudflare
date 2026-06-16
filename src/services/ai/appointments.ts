/**
 * Appointment Service for AI Sales Agent.
 * Manages appointment scheduling, availability configuration, conflict detection,
 * and tenant-scoped appointment lifecycle operations.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import type { Appointment, AppointmentAvailability } from '../../types/ai';

/**
 * AppointmentService provides tenant-scoped appointment management.
 * All operations enforce tenant isolation.
 */
export class AppointmentService {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Configure availability slots for a tenant.
   * Replaces existing availability configuration with new slots.
   *
   * @param tenantId - The tenant configuring availability
   * @param slots - Array of availability slot configurations
   * @returns Array of saved AppointmentAvailability records
   */
  async configureAvailability(
    tenantId: string,
    slots: Array<{
      day_of_week: number;
      time_start: string;
      time_end: string;
      slot_duration_minutes?: number;
      buffer_minutes?: number;
    }>
  ): Promise<AppointmentAvailability[]> {
    // Deactivate all existing availability for this tenant
    await this.db
      .prepare('UPDATE appointment_availability SET active = 0 WHERE tenant_id = ?')
      .bind(tenantId)
      .run();

    const savedSlots: AppointmentAvailability[] = [];

    for (const slot of slots) {
      const id = crypto.randomUUID();
      const record: AppointmentAvailability = {
        id,
        tenant_id: tenantId,
        day_of_week: slot.day_of_week,
        time_start: slot.time_start,
        time_end: slot.time_end,
        slot_duration_minutes: slot.slot_duration_minutes ?? 60,
        buffer_minutes: slot.buffer_minutes ?? 15,
        active: 1,
      };

      await this.db
        .prepare(
          `INSERT INTO appointment_availability (id, tenant_id, day_of_week, time_start, time_end, slot_duration_minutes, buffer_minutes, active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          record.id,
          record.tenant_id,
          record.day_of_week,
          record.time_start,
          record.time_end,
          record.slot_duration_minutes,
          record.buffer_minutes,
          record.active
        )
        .run();

      savedSlots.push(record);
    }

    return savedSlots;
  }

  /**
   * Get available time slots for a specific date.
   * Checks day_of_week availability configuration, then excludes existing appointments
   * (including buffer time) to return only open slots.
   *
   * @param tenantId - The tenant to check availability for
   * @param date - The date to check (YYYY-MM-DD format)
   * @returns Array of available time slot strings (HH:MM format)
   */
  async getAvailableSlots(tenantId: string, date: string): Promise<string[]> {
    // Determine day of week from the date
    const dateObj = new Date(date + 'T00:00:00Z');
    const dayOfWeek = dateObj.getUTCDay(); // 0=Sunday, 6=Saturday

    // Get availability configuration for this day
    const availabilityResult = await this.db
      .prepare(
        `SELECT * FROM appointment_availability
         WHERE tenant_id = ? AND day_of_week = ? AND active = 1`
      )
      .bind(tenantId, dayOfWeek)
      .all<AppointmentAvailability>();

    const availabilitySlots = availabilityResult.results ?? [];

    if (availabilitySlots.length === 0) {
      return [];
    }

    // Get existing appointments for this date (non-cancelled)
    const existingResult = await this.db
      .prepare(
        `SELECT time_start, time_end, duration_minutes FROM appointments
         WHERE tenant_id = ? AND date = ? AND status != 'cancelled'`
      )
      .bind(tenantId, date)
      .all<{ time_start: string; time_end: string; duration_minutes: number }>();

    const existingAppointments = existingResult.results ?? [];

    // Generate all possible slots and exclude conflicting ones
    const availableSlots: string[] = [];

    for (const avail of availabilitySlots) {
      const slotDuration = avail.slot_duration_minutes;
      const bufferMinutes = avail.buffer_minutes;

      // Parse availability window
      const startMinutes = timeToMinutes(avail.time_start);
      const endMinutes = timeToMinutes(avail.time_end);

      // Generate slots within the availability window
      let currentSlotStart = startMinutes;

      while (currentSlotStart + slotDuration <= endMinutes) {
        const slotEnd = currentSlotStart + slotDuration;
        const slotStartStr = minutesToTime(currentSlotStart);

        // Check if this slot conflicts with any existing appointment (including buffer)
        const hasConflict = existingAppointments.some((existing) => {
          const existStart = timeToMinutes(existing.time_start);
          const existEnd = timeToMinutes(existing.time_end);

          // Add buffer around existing appointment
          const blockedStart = existStart - bufferMinutes;
          const blockedEnd = existEnd + bufferMinutes;

          // Check overlap: slot [currentSlotStart, slotEnd] vs blocked [blockedStart, blockedEnd]
          return currentSlotStart < blockedEnd && slotEnd > blockedStart;
        });

        if (!hasConflict) {
          availableSlots.push(slotStartStr);
        }

        currentSlotStart += slotDuration;
      }
    }

    return availableSlots;
  }

  /**
   * Book an appointment for a contact.
   * Validates against conflicts before creating the record.
   *
   * @param tenantId - The tenant booking the appointment
   * @param contactId - The contact being booked
   * @param date - The appointment date (YYYY-MM-DD)
   * @param timeStart - The start time (HH:MM)
   * @param duration - Duration in minutes
   * @param notes - Optional notes for the appointment
   * @returns The created Appointment record
   * @throws Error if there is a time conflict
   */
  async bookAppointment(
    tenantId: string,
    contactId: string,
    date: string,
    timeStart: string,
    duration: number,
    notes?: string
  ): Promise<Appointment> {
    // Calculate time_end
    const startMinutes = timeToMinutes(timeStart);
    const endMinutes = startMinutes + duration;
    const timeEnd = minutesToTime(endMinutes);

    // Check for conflicts with existing appointments
    const conflictResult = await this.db
      .prepare(
        `SELECT id FROM appointments
         WHERE tenant_id = ? AND date = ? AND status != 'cancelled'
         AND time_start < ? AND time_end > ?`
      )
      .bind(tenantId, date, timeEnd, timeStart)
      .first<{ id: string }>();

    if (conflictResult) {
      throw new Error(`Time conflict: an appointment already exists at ${date} ${timeStart}`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const appointment: Appointment = {
      id,
      tenant_id: tenantId,
      contact_id: contactId,
      date,
      time_start: timeStart,
      time_end: timeEnd,
      duration_minutes: duration,
      status: 'confirmed',
      notes: notes ?? null,
      reminder_24h_sent: 0,
      reminder_1h_sent: 0,
      created_at: now,
      updated_at: now,
    };

    await this.db
      .prepare(
        `INSERT INTO appointments (id, tenant_id, contact_id, date, time_start, time_end, duration_minutes, status, notes, reminder_24h_sent, reminder_1h_sent, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        appointment.id,
        appointment.tenant_id,
        appointment.contact_id,
        appointment.date,
        appointment.time_start,
        appointment.time_end,
        appointment.duration_minutes,
        appointment.status,
        appointment.notes,
        appointment.reminder_24h_sent,
        appointment.reminder_1h_sent,
        appointment.created_at,
        appointment.updated_at
      )
      .run();

    return appointment;
  }

  /**
   * Cancel an appointment by updating its status to 'cancelled'.
   *
   * @param tenantId - The tenant owning the appointment
   * @param appointmentId - The appointment to cancel
   * @returns The updated Appointment record
   * @throws Error if appointment not found
   */
  async cancelAppointment(tenantId: string, appointmentId: string): Promise<Appointment> {
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `UPDATE appointments SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND tenant_id = ?`
      )
      .bind(now, appointmentId, tenantId)
      .run();

    const updated = await this.db
      .prepare('SELECT * FROM appointments WHERE id = ? AND tenant_id = ?')
      .bind(appointmentId, tenantId)
      .first<Appointment>();

    if (!updated) {
      throw new Error(`Appointment ${appointmentId} not found for tenant ${tenantId}`);
    }

    return updated;
  }

  /**
   * List appointments for a tenant with optional filters and pagination.
   *
   * @param tenantId - The tenant to list appointments for
   * @param filters - Optional filters for status, date range, and pagination
   * @returns Object with appointments array and total count
   */
  async listAppointments(
    tenantId: string,
    filters?: {
      status?: string;
      date_from?: string;
      date_to?: string;
      contact_id?: string;
      limit?: number;
      offset?: number;
    }
  ): Promise<{ appointments: Appointment[]; total: number }> {
    const limit = filters?.limit ?? 20;
    const offset = filters?.offset ?? 0;

    let whereClause = 'WHERE tenant_id = ?';
    const params: unknown[] = [tenantId];

    if (filters?.status) {
      whereClause += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters?.date_from) {
      whereClause += ' AND date >= ?';
      params.push(filters.date_from);
    }

    if (filters?.date_to) {
      whereClause += ' AND date <= ?';
      params.push(filters.date_to);
    }

    if (filters?.contact_id) {
      whereClause += ' AND contact_id = ?';
      params.push(filters.contact_id);
    }

    // Get total count
    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as count FROM appointments ${whereClause}`)
      .bind(...params)
      .first<{ count: number }>();

    const total = countResult?.count ?? 0;

    // Get paginated results
    const results = await this.db
      .prepare(
        `SELECT * FROM appointments ${whereClause} ORDER BY date ASC, time_start ASC LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, offset)
      .all<Appointment>();

    return {
      appointments: results.results ?? [],
      total,
    };
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Converts a time string (HH:MM) to total minutes from midnight.
 */
function timeToMinutes(time: string): number {
  const parts = time.split(':');
  const hours = parseInt(parts[0] ?? '0', 10);
  const minutes = parseInt(parts[1] ?? '0', 10);
  return hours * 60 + minutes;
}

/**
 * Converts total minutes from midnight to a time string (HH:MM).
 */
function minutesToTime(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}
