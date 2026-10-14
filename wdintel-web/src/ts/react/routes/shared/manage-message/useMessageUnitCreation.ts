import { useEffect, useRef, useState } from 'react';
import type { Unit } from '../../../../../Bindings';
import type { UnitFormSubmit } from '../../rer-units-neo/components/UnitFormDrawer';
import { formatUnitError } from '../../rer-units-neo/helpers';
import { currentSystemSettings } from '../../../services/api/system-settings';
import { createUnit, createUnitWithAutoNetwork } from '../../../services/api/units';

type CreationForm = {
  initialName: string;
  devicesSectionEnabled: boolean;
  hideNetworks: boolean;
};

export function useMessageUnitCreation(onCreated: (unit: Unit) => void) {
  const [form, setForm] = useState<CreationForm | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef(0);
  const inFlight = useRef(false);

  useEffect(
    () => () => {
      session.current += 1;
    },
    [],
  );

  async function open(name: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++session.current;
    setLoading(true);
    setError(null);
    try {
      const settings = await currentSystemSettings();
      if (session.current !== version) return;
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      setForm({
        initialName: name.trim(),
        devicesSectionEnabled: settings.devicesSectionEnabled,
        hideNetworks: settings.hideNetworks,
      });
    } catch (error) {
      if (session.current === version) setError(formatUnitError(error));
    } finally {
      if (session.current === version) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }

  function close() {
    if (inFlight.current) return;
    session.current += 1;
    setForm(null);
    setError(null);
  }

  async function submit(value: UnitFormSubmit) {
    if (inFlight.current || form === null) return;
    inFlight.current = true;
    const version = session.current;
    setSubmitting(true);
    setError(null);
    try {
      const unit =
        value.autoNetwork === undefined
          ? await createUnit(value.unit)
          : (await createUnitWithAutoNetwork({ unit: value.unit, ...value.autoNetwork })).unit;
      if (session.current !== version) return;
      onCreated(unit);
      setForm(null);
    } catch (error) {
      if (session.current === version) setError(formatUnitError(error));
    } finally {
      if (session.current === version) {
        inFlight.current = false;
        setSubmitting(false);
      }
    }
  }

  return { form, loading, submitting, error, open, close, submit };
}
