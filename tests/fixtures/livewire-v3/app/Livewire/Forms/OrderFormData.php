<?php

namespace App\Livewire\Forms;

use Livewire\Form;
use Livewire\Attributes\Validate;

class OrderFormData extends Form
{
    #[Validate('required|min:3')]
    public string $notes = '';

    #[Validate('required|numeric')]
    public float $total = 0.0;

    public function store(): void
    {
        $this->validate();
    }
}
