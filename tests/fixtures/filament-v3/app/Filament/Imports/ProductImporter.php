<?php

namespace App\Filament\Imports;

use App\Models\Product;
use Filament\Actions\Imports\Importer;
use Filament\Actions\Imports\ImportColumn;

class ProductImporter extends Importer
{
    protected static ?string $model = Product::class;

    public static function getColumns(): array
    {
        return [
            ImportColumn::make('name')->requiredMapping()->rules(['required']),
            ImportColumn::make('sku')->requiredMapping(),
            ImportColumn::make('price')->numeric(),
        ];
    }

    public function resolveRecord(): ?Product
    {
        return Product::firstOrNew(['sku' => $this->data['sku']]);
    }
}
