import React from 'react';
import { View, Text } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

const BiometricsModule = TurboModuleRegistry.getEnforcing('BiometricsModule');

export function ProfileScreen({ route, navigation }: any) {
  const { userId } = route.params;
  return (
    <View>
      <Text>Profile {userId}</Text>
      <Button title="Settings" onPress={() => navigation.push('Settings')} />
    </View>
  );
}
