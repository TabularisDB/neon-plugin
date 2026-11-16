import type {MouseEvent} from 'react';

/** Native form submission is blocked in the guest; dispatch the existing JS handler instead. */
export function submitPluginForm(event: MouseEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const form = event.currentTarget.form;
    if (!form?.reportValidity()) return;
    const EventType = form.ownerDocument.defaultView?.Event ?? Event;
    form.dispatchEvent(new EventType('submit', {bubbles: true, cancelable: true}));
}
